// Play → PowerPoint (.pptx) exporter. The file Google Slides imports
// cleanly via File → Open → Upload → opens as an editable deck, or
// lives natively in a Drive folder. We ship .pptx instead of hitting
// the Slides API directly so there's no OAuth step in the loop —
// the AE downloads, uploads to Drive, and shares from there.
//
// Visual language mirrors the Ambition corporate deck: white
// background, AMBITION wordmark + circular mark in the corner,
// slate-900 bold titles, emerald accents for champion/positive and
// a soft rose for risks/"what fails", and a "Month YYYY · ambition.com"
// footer on every slide.
//
// Deck structure (same order every time so the AE can skim):
//   1. Title — the play, the account, the date
//   2. The play at a glance — instinct + hypothesis + contact path
//   3. Execution path — sequenced moves as a numbered timeline
//   4. Artifact slides — one per move that has a draft to paste
//   5. Stakeholder narratives — who needs to believe what
//   6. Risks · internal ask · positioning hooks
//
// Voice rule: champion-voice artifacts get an emerald accent bar so
// the AE can see at-a-glance which slides they're meant to forward
// vs. which are internal AE-only coach-notes.

import PptxGenJS from 'pptxgenjs';

// Brand palette — aligned to the Ambition marketing deck.
const COLORS = {
  ink:        '0F172A',   // slate-900 — titles
  body:       '334155',   // slate-700 — copy
  muted:      '64748B',   // slate-500 — captions, footers
  rule:       'E2E8F0',   // slate-200 — hairlines
  pageBg:     'FFFFFF',   // white page
  ambition:   '10B981',   // emerald-500 — Ambition green
  ambitionLo: 'D1FAE5',   // emerald-100 — soft fill
  aeAccent:   '1E293B',   // slate-800 — AE voice
  internal:   '0284C7',   // sky-600 — internal colleague voice
  rose:       'F43F5E',   // rose-500 — risks / "what fails" column
  roseLo:     'FFE4E6',   // rose-100
  chipBg:     'F1F5F9',   // slate-100
};

const ACTOR_TAG = {
  champion:           { label: 'CHAMPION CARRIES', color: COLORS.ambition },
  ae:                 { label: 'YOU (COACH)',       color: COLORS.aeAccent },
  internal_colleague: { label: 'INTERNAL ASSIST',   color: COLORS.internal },
};

const ARTIFACT_TYPE_LABEL = {
  slack_forward:      'Slack forward',
  exec_talking_points:'Exec talking points',
  one_pager:          'One-pager',
  question_to_raise:  'Question to raise',
  meeting_pre_read:   'Meeting pre-read',
};

// LAYOUT_WIDE is 13.333 × 7.5 inches. Constants so future edits don't
// drift from the brand grid.
const PAGE_W = 13.333;
const PAGE_H = 7.5;
const MARGIN_X = 0.6;

// Build a filename that's safe on Drive/Windows: lowercase, hyphens,
// only alphanumerics, capped length. "TriNet — Hub-not-spoke" →
// "trinet-hub-not-spoke-play.pptx".
export function buildFilename(accountName, namedPlay) {
  const slug = `${accountName || 'account'}-${namedPlay || 'play'}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || 'play'}.pptx`;
}

// Main entry point — returns a Node Buffer of the .pptx file. The
// caller streams this back to the browser with a
// Content-Disposition: attachment header.
export async function renderPlayPptx({ play, account, hypothesis, contacts = [] }) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = play.ai_expansion?.named_play || 'Account play';
  pptx.company = 'Ambition';

  const exp = play.ai_expansion || {};
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const pathResolved = (play.contact_path || []).map((id) => byId.get(id)).filter(Boolean);

  const footerDate = new Date(play.created_at || Date.now())
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const ctx = { pptx, footerDate };

  addTitleSlide(ctx, { play, account, exp });
  addOverviewSlide(ctx, { play, account, exp, pathResolved, hypothesis });

  if (Array.isArray(exp.moves) && exp.moves.length > 0) {
    addMovesSlides(ctx, exp.moves);
    for (const move of exp.moves) {
      const content = move?.artifact?.content;
      if (content && String(content).trim()) {
        addArtifactSlide(ctx, move);
      }
    }
  }

  if (exp.stakeholder_narratives && Object.keys(exp.stakeholder_narratives).length > 0) {
    addStakeholdersSlide(ctx, exp.stakeholder_narratives);
  }

  addClosingSlide(ctx, exp);

  const buf = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

// ---------- branding primitives ----------

// Ambition wordmark — small "o" circle in emerald + bold "AMBITION"
// in slate-900. Approximates the real logo; on a corporate-polished
// deck the AE can swap in the real SVG via Slides > Insert > Image
// after upload.
function addWordmark(s, { x, y, size = 1.0 } = {}) {
  const ringR = 0.13 * size;
  // Open circle — stroke only, emerald. Placed as the "O" preceding AMBITION.
  s.addShape('ellipse', {
    x, y: y + 0.03 * size, w: ringR * 2, h: ringR * 2,
    fill: { type: 'none' }, line: { color: COLORS.ambition, width: 2 * size },
  });
  s.addText('AMBITION', {
    x: x + ringR * 2 + 0.08, y, w: 1.6 * size, h: 0.35 * size,
    color: COLORS.ink, fontSize: 14 * size, bold: true, fontFace: 'Calibri',
    charSpacing: 2, valign: 'middle',
  });
}

// Bottom-of-page footer: thin rule + "Month YYYY" left + "ambition.com" right.
function addFooter(s, { footerDate }) {
  s.addShape('line', {
    x: MARGIN_X, y: PAGE_H - 0.55, w: PAGE_W - MARGIN_X * 2, h: 0,
    line: { color: COLORS.rule, width: 0.75 },
  });
  s.addText(footerDate, {
    x: MARGIN_X, y: PAGE_H - 0.45, w: 3.0, h: 0.3,
    color: COLORS.muted, fontSize: 10, fontFace: 'Calibri',
  });
  s.addText('ambition.com', {
    x: PAGE_W - 3.0 - MARGIN_X, y: PAGE_H - 0.45, w: 3.0, h: 0.3,
    color: COLORS.muted, fontSize: 10, fontFace: 'Calibri', align: 'right',
  });
}

// Shared "content slide" chrome: white background, wordmark top-right,
// footer. Call at the top of every content slide.
function dressContentSlide(pptx, ctx) {
  const s = pptx.addSlide();
  s.background = { color: COLORS.pageBg };
  addWordmark(s, { x: PAGE_W - MARGIN_X - 1.7, y: 0.35, size: 0.85 });
  addFooter(s, ctx);
  return s;
}

// Large "page title" block. Keeps the grid consistent across content
// slides so a deck feels like one document.
function addPageTitle(s, { title, subtitle, kicker }) {
  let y = 0.45;
  if (kicker) {
    s.addText(kicker.toUpperCase(), {
      x: MARGIN_X, y, w: 9.0, h: 0.3,
      color: COLORS.ambition, fontSize: 11, bold: true, charSpacing: 4, fontFace: 'Calibri',
    });
    y += 0.35;
  }
  s.addText(title, {
    x: MARGIN_X, y, w: 10.5, h: 0.85,
    color: COLORS.ink, fontSize: 32, bold: true, fontFace: 'Calibri', valign: 'top',
  });
  if (subtitle) {
    s.addText(subtitle, {
      x: MARGIN_X, y: y + 0.9, w: 10.5, h: 0.5,
      color: COLORS.muted, fontSize: 14, fontFace: 'Calibri',
    });
  }
}

// ---------- slide builders ----------

function addTitleSlide({ pptx, footerDate }, { play, account, exp }) {
  const s = pptx.addSlide();
  s.background = { color: COLORS.pageBg };

  // Wordmark top-left, slightly larger than content slides.
  addWordmark(s, { x: MARGIN_X, y: 0.55, size: 1.25 });

  // Kicker above the title.
  s.addText('GAME PLAN', {
    x: MARGIN_X, y: 2.25, w: 8, h: 0.35,
    color: COLORS.ambition, fontSize: 13, bold: true, charSpacing: 4, fontFace: 'Calibri',
  });

  // Big bold title — the named play.
  const titleText = exp.named_play || 'Account play';
  s.addText(titleText, {
    x: MARGIN_X, y: 2.7, w: 8.0, h: 2.4,
    color: COLORS.ink, fontSize: 52, bold: true, fontFace: 'Calibri',
    valign: 'top',
  });

  // Subtitle — the account line.
  const sub = `for ${account?.account_name || 'Account'}${account?.industry ? ' · ' + account.industry : ''}`;
  s.addText(sub, {
    x: MARGIN_X, y: 5.25, w: 8.0, h: 0.6,
    color: COLORS.body, fontSize: 20, fontFace: 'Calibri',
  });

  // Right-side decorative bars — approximates the brand-deck artwork
  // (horizontal bars with avatars). We draw bars only since the real
  // asset isn't in the repo; AE can swap art after upload if they want.
  const bars = [
    { w: 4.5, color: COLORS.ambition,   softW: 0.6 },
    { w: 3.8, color: '5EEAD4',          softW: 0.9 },  // teal-300
    { w: 3.2, color: 'FCD34D',          softW: 0.5 },  // amber-300
    { w: 4.2, color: '818CF8',          softW: 1.2 },  // indigo-400
  ];
  const barStartX = 8.8;
  const barStartY = 2.8;
  const barH = 0.55;
  const barGap = 0.55;
  bars.forEach((b, i) => {
    const y = barStartY + i * barGap;
    // Soft lead
    s.addShape('rect', {
      x: barStartX, y, w: b.softW, h: barH,
      fill: { color: b.color, transparency: 70 }, line: { type: 'none' },
    });
    // Main bar
    s.addShape('rect', {
      x: barStartX + b.softW + 0.08, y, w: b.w - b.softW - 0.08, h: barH,
      fill: { color: b.color }, line: { type: 'none' },
    });
    // Circular "avatar" cap at the end
    s.addShape('ellipse', {
      x: barStartX + b.w + 0.1, y: y - 0.12, w: barH + 0.25, h: barH + 0.25,
      fill: { color: COLORS.pageBg },
      line: { color: b.color, width: 2 },
    });
  });

  addFooter(s, { footerDate });
}

function addOverviewSlide(ctx, { play, account, exp, pathResolved, hypothesis }) {
  const s = dressContentSlide(ctx.pptx, ctx);

  addPageTitle(s, {
    kicker: 'The play at a glance',
    title: exp.named_play || 'The play',
    subtitle: account?.account_name ? `For ${account.account_name}` : null,
  });

  const COL_Y = 2.35;

  // Left column: YOUR INSTINCT
  s.addText('YOUR INSTINCT', {
    x: MARGIN_X, y: COL_Y, w: 6.0, h: 0.3,
    color: COLORS.muted, fontSize: 10, bold: true, charSpacing: 3, fontFace: 'Calibri',
  });
  s.addText(play.instinct || '—', {
    x: MARGIN_X, y: COL_Y + 0.35, w: 6.0, h: 1.2,
    color: COLORS.ink, fontSize: 14, fontFace: 'Calibri', valign: 'top',
  });

  // Left column: HYPOTHESIS
  if (hypothesis?.narrative_hook) {
    s.addText('HYPOTHESIS', {
      x: MARGIN_X, y: COL_Y + 1.7, w: 6.0, h: 0.3,
      color: COLORS.muted, fontSize: 10, bold: true, charSpacing: 3, fontFace: 'Calibri',
    });
    s.addText(hypothesis.narrative_hook, {
      x: MARGIN_X, y: COL_Y + 2.05, w: 6.0, h: 1.1,
      color: COLORS.body, fontSize: 12, fontFace: 'Calibri', valign: 'top',
    });

    // Three-beat narrative
    const n = hypothesis.narrative;
    if (n && (n.current_state || n.future_state || n.bridge)) {
      const beats = [];
      if (n.current_state) beats.push({ tag: 'TODAY', text: n.current_state });
      if (n.future_state)  beats.push({ tag: "IF WE WIN", text: n.future_state });
      if (n.bridge)        beats.push({ tag: 'BRIDGE', text: n.bridge });
      const startY = COL_Y + 3.3;
      const h = Math.max(0.4, 1.2 / Math.max(beats.length, 1));
      beats.forEach((b, i) => {
        s.addText(
          [
            { text: `${b.tag}  `, options: { bold: true, color: COLORS.ambition, fontSize: 9 } },
            { text: b.text, options: { color: COLORS.body, fontSize: 10 } },
          ],
          { x: MARGIN_X, y: startY + i * h, w: 6.0, h, fontFace: 'Calibri', valign: 'top' }
        );
      });
    }
  }

  // Right column: CONTACT PATH — rendered as a vertical numbered
  // timeline so it reads as "who we move through, in order."
  const pathX = 7.2;
  s.addText('THE PATH IN', {
    x: pathX, y: COL_Y, w: 5.5, h: 0.3,
    color: COLORS.muted, fontSize: 10, bold: true, charSpacing: 3, fontFace: 'Calibri',
  });

  if (pathResolved.length === 0) {
    s.addText('No path set yet.', {
      x: pathX, y: COL_Y + 0.4, w: 5.5, h: 0.4,
      color: COLORS.muted, fontSize: 12, italic: true, fontFace: 'Calibri',
    });
  } else {
    const rowH = 0.7;
    const startY = COL_Y + 0.4;
    const maxRows = Math.min(pathResolved.length, 6);

    // Connector rail behind the dots
    if (maxRows > 1) {
      s.addShape('line', {
        x: pathX + 0.2, y: startY + 0.2,
        w: 0, h: (maxRows - 1) * rowH,
        line: { color: COLORS.rule, width: 1.5 },
      });
    }

    pathResolved.slice(0, maxRows).forEach((c, i) => {
      const y = startY + i * rowH;
      const isChampion = c.deal_role === 'champion';
      // Numbered dot
      s.addShape('ellipse', {
        x: pathX, y: y + 0.05, w: 0.4, h: 0.4,
        fill: { color: isChampion ? COLORS.ambition : COLORS.pageBg },
        line: { color: isChampion ? COLORS.ambition : COLORS.muted, width: 1.5 },
      });
      s.addText(String(i + 1), {
        x: pathX, y: y + 0.05, w: 0.4, h: 0.4,
        color: isChampion ? 'FFFFFF' : COLORS.ink,
        fontSize: 11, bold: true, align: 'center', valign: 'middle', fontFace: 'Calibri',
      });
      s.addText(
        [
          { text: c.name || '—', options: { bold: true, color: COLORS.ink, fontSize: 13 } },
          { text: c.title ? `   ${c.title}` : '', options: { color: COLORS.muted, fontSize: 10 } },
        ],
        { x: pathX + 0.55, y, w: 4.95, h: 0.35, fontFace: 'Calibri', valign: 'middle' }
      );
      if (c.deal_role || c.stance) {
        s.addText(
          `${c.deal_role || ''}${c.deal_role && c.stance ? ' · ' : ''}${c.stance || ''}`,
          {
            x: pathX + 0.55, y: y + 0.32, w: 4.95, h: 0.3,
            color: isChampion ? COLORS.ambition : COLORS.muted,
            fontSize: 10, italic: true, fontFace: 'Calibri',
          }
        );
      }
    });
  }
}

function addMovesSlides(ctx, moves) {
  const { pptx } = ctx;
  // 3 moves per slide reads cleanly without crowding.
  const chunks = [];
  for (let i = 0; i < moves.length; i += 3) chunks.push(moves.slice(i, i + 3));

  chunks.forEach((chunk, chunkIdx) => {
    const s = dressContentSlide(pptx, ctx);
    const suffix = chunks.length > 1 ? ` (${chunkIdx + 1}/${chunks.length})` : '';
    addPageTitle(s, {
      kicker: 'Execution path',
      title: `Sequenced moves${suffix}`,
      subtitle: 'The playbook, in order — who moves, when, and what they ask.',
    });

    const rowH = 1.55;
    const startY = 2.5;
    chunk.forEach((m, i) => {
      const y = startY + i * rowH;
      const tag = ACTOR_TAG[m.actor_type] || ACTOR_TAG.ae;

      // Step circle — emerald filled for visual cadence.
      s.addShape('ellipse', {
        x: MARGIN_X, y: y + 0.1, w: 0.6, h: 0.6,
        fill: { color: COLORS.ambition }, line: { color: COLORS.ambition },
      });
      s.addText(String(m.step ?? i + 1), {
        x: MARGIN_X, y: y + 0.1, w: 0.6, h: 0.6,
        color: 'FFFFFF', fontSize: 18, bold: true,
        align: 'center', valign: 'middle', fontFace: 'Calibri',
      });

      // Actor-type tag (caps, colored)
      s.addText(tag.label, {
        x: MARGIN_X + 0.8, y: y + 0.02, w: 3.0, h: 0.28,
        color: tag.color, fontSize: 9, bold: true, charSpacing: 3, fontFace: 'Calibri',
      });

      // Actor name + channel + day
      s.addText(
        [
          { text: m.actor || '—', options: { bold: true, color: COLORS.ink, fontSize: 14 } },
          { text: `   ${m.channel || ''}${m.channel && m.days_from_now != null ? ' · ' : ''}${m.days_from_now != null ? `day ${m.days_from_now}` : ''}`,
            options: { color: COLORS.muted, fontSize: 11 } },
        ],
        { x: MARGIN_X + 0.8, y: y + 0.3, w: 11.5, h: 0.32, fontFace: 'Calibri' }
      );

      // Ask
      s.addText(m.ask || '', {
        x: MARGIN_X + 0.8, y: y + 0.7, w: 11.0, h: 0.4,
        color: COLORS.body, fontSize: 12, fontFace: 'Calibri', valign: 'top',
      });
      if (m.rationale) {
        s.addText(m.rationale, {
          x: MARGIN_X + 0.8, y: y + 1.1, w: 11.0, h: 0.35,
          color: COLORS.muted, fontSize: 10, italic: true, fontFace: 'Calibri', valign: 'top',
        });
      }

      // Artifact indicator
      const hasArtifact = m.artifact && m.artifact.content && String(m.artifact.content).trim();
      if (hasArtifact) {
        s.addText('📋 artifact on next slide', {
          x: PAGE_W - MARGIN_X - 2.2, y: y + 0.02, w: 2.2, h: 0.28,
          color: COLORS.ambition, fontSize: 9, bold: true, align: 'right', fontFace: 'Calibri',
        });
      }

      // Row divider
      s.addShape('line', {
        x: MARGIN_X, y: y + rowH - 0.08, w: PAGE_W - MARGIN_X * 2, h: 0,
        line: { color: COLORS.rule, width: 0.75 },
      });
    });
  });
}

function addArtifactSlide(ctx, move) {
  const s = dressContentSlide(ctx.pptx, ctx);

  const typeLabel = ARTIFACT_TYPE_LABEL[move.artifact.type] || 'Artifact';
  const forChampion = move.artifact.for_actor === 'champion';
  const accent = forChampion ? COLORS.ambition : COLORS.aeAccent;
  const fill = forChampion ? COLORS.ambitionLo : COLORS.chipBg;

  // Accent bar left edge — at-a-glance "champion forwards this" signal.
  s.addShape('rect', {
    x: 0, y: 0, w: 0.15, h: PAGE_H,
    fill: { color: accent }, line: { type: 'none' },
  });

  addPageTitle(s, {
    kicker: `Step ${move.step ?? ''}: ${typeLabel}`,
    title: forChampion ? "For the champion to paste" : 'For you to carry',
    subtitle: forChampion ? 'Champion voice — forward as-is' : 'AE voice — internal framing',
  });

  // Artifact panel
  s.addShape('roundRect', {
    x: MARGIN_X, y: 2.5, w: PAGE_W - MARGIN_X * 2, h: 4.2,
    fill: { color: fill }, line: { color: COLORS.rule, width: 0.5 },
    rectRadius: 0.1,
  });
  s.addText(move.artifact.content, {
    x: MARGIN_X + 0.2, y: 2.65, w: PAGE_W - MARGIN_X * 2 - 0.4, h: 3.95,
    color: COLORS.ink, fontSize: 13, fontFace: 'Calibri', valign: 'top',
  });

  // Meta row under the panel
  s.addText(
    [
      { text: `${move.actor || ''}`, options: { color: COLORS.body, fontSize: 10, bold: true } },
      { text: `   ${move.channel || ''}${move.channel && move.days_from_now != null ? ' · ' : ''}${move.days_from_now != null ? `day ${move.days_from_now}` : ''}`,
        options: { color: COLORS.muted, fontSize: 10, italic: true } },
    ],
    { x: MARGIN_X, y: 6.8, w: PAGE_W - MARGIN_X * 2, h: 0.3, fontFace: 'Calibri' }
  );
}

function addStakeholdersSlide(ctx, narratives) {
  const s = dressContentSlide(ctx.pptx, ctx);
  addPageTitle(s, {
    kicker: 'Stakeholder narratives',
    title: 'What each person needs to believe',
    subtitle: 'In the champion\u2019s voice, not yours.',
  });

  const entries = Object.entries(narratives).slice(0, 6);
  const rowH = 4.3 / Math.max(entries.length, 1);
  entries.forEach(([name, text], i) => {
    const y = 2.4 + i * rowH;
    // Name pill
    s.addShape('roundRect', {
      x: MARGIN_X, y: y + 0.05, w: 3.0, h: rowH - 0.15,
      fill: { color: COLORS.ambitionLo }, line: { color: COLORS.ambition, width: 0.75 },
      rectRadius: 0.08,
    });
    s.addText(name, {
      x: MARGIN_X + 0.15, y: y + 0.05, w: 2.7, h: rowH - 0.15,
      color: COLORS.ambition, fontSize: 13, bold: true, fontFace: 'Calibri', valign: 'middle',
    });
    // Narrative body
    s.addText(text, {
      x: MARGIN_X + 3.3, y, w: PAGE_W - MARGIN_X * 2 - 3.3, h: rowH - 0.1,
      color: COLORS.body, fontSize: 12, fontFace: 'Calibri', valign: 'top',
    });
  });
}

function addClosingSlide(ctx, exp) {
  const s = dressContentSlide(ctx.pptx, ctx);
  addPageTitle(s, {
    kicker: 'Coach notes',
    title: 'Risks · internal ask · positioning',
    subtitle: 'Read before you run the play.',
  });

  let y = 2.4;

  if (exp.internal_ask) {
    s.addText('INTERNAL ASK', {
      x: MARGIN_X, y, w: PAGE_W - MARGIN_X * 2, h: 0.3,
      color: COLORS.muted, fontSize: 10, bold: true, charSpacing: 3, fontFace: 'Calibri',
    });
    s.addText(exp.internal_ask, {
      x: MARGIN_X, y: y + 0.3, w: PAGE_W - MARGIN_X * 2, h: 0.8,
      color: COLORS.ink, fontSize: 13, fontFace: 'Calibri', valign: 'top',
    });
    y += 1.3;
  }

  if (Array.isArray(exp.risks) && exp.risks.length > 0) {
    s.addText('RISKS', {
      x: MARGIN_X, y, w: PAGE_W - MARGIN_X * 2, h: 0.3,
      color: COLORS.rose, fontSize: 10, bold: true, charSpacing: 3, fontFace: 'Calibri',
    });
    const bullets = exp.risks.map((r) => ({ text: r, options: { bullet: { code: '25A0' } } }));
    s.addText(bullets, {
      x: MARGIN_X, y: y + 0.3, w: PAGE_W - MARGIN_X * 2, h: 1.6,
      color: COLORS.body, fontSize: 12, fontFace: 'Calibri', paraSpaceAfter: 6, valign: 'top',
    });
    y += 2.0;
  }

  if (Array.isArray(exp.positioning_hooks) && exp.positioning_hooks.length > 0) {
    s.addText('POSITIONING HOOKS', {
      x: MARGIN_X, y, w: PAGE_W - MARGIN_X * 2, h: 0.3,
      color: COLORS.muted, fontSize: 10, bold: true, charSpacing: 3, fontFace: 'Calibri',
    });
    // Render as soft chips
    let cx = MARGIN_X;
    let cy = y + 0.4;
    exp.positioning_hooks.forEach((hook) => {
      const estW = Math.min(6.0, 0.35 + String(hook).length * 0.09);
      if (cx + estW > PAGE_W - MARGIN_X) { cx = MARGIN_X; cy += 0.5; }
      s.addShape('roundRect', {
        x: cx, y: cy, w: estW, h: 0.4,
        fill: { color: COLORS.ambitionLo }, line: { color: COLORS.ambition, width: 0.5 },
        rectRadius: 0.08,
      });
      s.addText(hook, {
        x: cx, y: cy, w: estW, h: 0.4,
        color: COLORS.ink, fontSize: 10, align: 'center', valign: 'middle', fontFace: 'Calibri',
      });
      cx += estW + 0.15;
    });
  }
}
