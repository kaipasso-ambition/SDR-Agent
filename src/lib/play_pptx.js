// Play → PowerPoint (.pptx) exporter. The file Google Slides imports
// cleanly via File → Open → Upload → opens as an editable deck, or
// lives natively in a Drive folder. We ship .pptx instead of hitting
// the Slides API directly so there's no OAuth step in the loop —
// the AE downloads, uploads to Drive, and shares from there.
//
// The deck mirrors the Nasralla / play-builder output:
//   1. Title
//   2. The play at a glance (named_play + instinct + path)
//   3. Moves (one slide, or split across slides if >4 moves)
//   4. Champion artifacts (one slide per artifact — these are what
//      actually get pasted into Slack/email by the champion)
//   5. Stakeholder narratives
//   6. Risks + internal ask + positioning hooks
//
// Voice rule: champion-voice artifacts appear on their own slides with
// an emerald accent so the AE can see at-a-glance which slides they're
// meant to forward vs. which are internal AE-only context.

import PptxGenJS from 'pptxgenjs';

const COLORS = {
  ink:        '0F172A',   // slate-900
  body:       '334155',   // slate-700
  muted:      '64748B',   // slate-500
  rule:       'E2E8F0',   // slate-200
  accent:     '059669',   // emerald-600  (champion voice)
  accentSoft: 'D1FAE5',   // emerald-100
  aeAccent:   '1E293B',   // slate-800    (AE voice)
  internal:   '0284C7',   // sky-600      (internal colleagues)
  risk:       'DC2626',   // red-600
  chipBg:     'F1F5F9',   // slate-100
  bg:         'FFFFFF',
};

const ACTOR_TAG = {
  champion:           { label: 'CHAMPION CARRIES', color: COLORS.accent },
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
  pptx.layout = 'LAYOUT_WIDE';         // 13.333 x 7.5 inches
  pptx.title = play.ai_expansion?.named_play || 'Account Play';
  pptx.company = 'Ambition.com';

  const exp = play.ai_expansion || {};
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const pathResolved = (play.contact_path || []).map((id) => byId.get(id)).filter(Boolean);

  addTitleSlide(pptx, { play, account, exp });
  addOverviewSlide(pptx, { play, account, exp, pathResolved, hypothesis });

  if (Array.isArray(exp.moves) && exp.moves.length > 0) {
    addMovesSlides(pptx, exp.moves);
    for (const move of exp.moves) {
      const content = move?.artifact?.content;
      if (content && String(content).trim()) {
        addArtifactSlide(pptx, move);
      }
    }
  }

  if (exp.stakeholder_narratives && Object.keys(exp.stakeholder_narratives).length > 0) {
    addStakeholdersSlide(pptx, exp.stakeholder_narratives);
  }

  addClosingSlide(pptx, exp);

  // pptxgenjs write() returns a base64 string or Buffer depending on
  // outputType. We request nodebuffer so Express can stream it.
  const buf = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

// ---------- slide builders ----------

function addTitleSlide(pptx, { play, account, exp }) {
  const s = pptx.addSlide();
  s.background = { color: COLORS.ink };

  s.addText('GAME PLAN', {
    x: 0.6, y: 0.5, w: 12, h: 0.4,
    color: COLORS.accent, fontSize: 14, bold: true, fontFace: 'Calibri', charSpacing: 4,
  });

  s.addText(exp.named_play || 'Untitled play', {
    x: 0.6, y: 1.4, w: 12, h: 2.2,
    color: 'FFFFFF', fontSize: 48, bold: true, fontFace: 'Calibri',
    valign: 'top',
  });

  s.addText(`${account?.account_name || 'Account'}${account?.industry ? ' · ' + account.industry : ''}`, {
    x: 0.6, y: 4.2, w: 12, h: 0.5,
    color: COLORS.accentSoft, fontSize: 20, fontFace: 'Calibri',
  });

  // Footer
  s.addText(
    `Built from your instinct · ${new Date(play.created_at || Date.now()).toLocaleDateString()}`,
    {
      x: 0.6, y: 6.7, w: 12, h: 0.3,
      color: COLORS.muted, fontSize: 10, fontFace: 'Calibri',
    }
  );
  s.addText('Ambition 2.0 — Performance Graph · GTM Governance', {
    x: 0.6, y: 7.0, w: 12, h: 0.3,
    color: COLORS.muted, fontSize: 10, italic: true, fontFace: 'Calibri',
  });
}

function addOverviewSlide(pptx, { play, account, exp, pathResolved, hypothesis }) {
  const s = pptx.addSlide();
  s.background = { color: COLORS.bg };

  addSectionHeader(s, 'The play at a glance', account?.account_name);

  // Two columns: left = instinct + hypothesis, right = path
  s.addText('YOUR INSTINCT', {
    x: 0.6, y: 1.6, w: 6.2, h: 0.3,
    color: COLORS.muted, fontSize: 10, bold: true, charSpacing: 3,
  });
  s.addText(play.instinct || '', {
    x: 0.6, y: 1.95, w: 6.2, h: 1.5,
    color: COLORS.ink, fontSize: 14, fontFace: 'Calibri', valign: 'top',
  });

  if (hypothesis) {
    s.addText('HYPOTHESIS', {
      x: 0.6, y: 3.6, w: 6.2, h: 0.3,
      color: COLORS.muted, fontSize: 10, bold: true, charSpacing: 3,
    });
    s.addText(hypothesis.narrative_hook || '', {
      x: 0.6, y: 3.95, w: 6.2, h: 1.2,
      color: COLORS.body, fontSize: 12, fontFace: 'Calibri', valign: 'top',
    });

    // Three-beat narrative (if present) — small stack
    const n = hypothesis.narrative;
    if (n && (n.current_state || n.future_state || n.bridge)) {
      const beats = [];
      if (n.current_state) beats.push({ tag: 'TODAY', text: n.current_state });
      if (n.future_state)  beats.push({ tag: "WHAT'D BE DIFFERENT", text: n.future_state });
      if (n.bridge)        beats.push({ tag: 'BRIDGE', text: n.bridge });
      const startY = 5.2;
      const h = 1.6 / Math.max(beats.length, 1);
      beats.forEach((b, i) => {
        s.addText(
          [
            { text: `${b.tag}  `, options: { bold: true, color: COLORS.accent, fontSize: 9 } },
            { text: b.text, options: { color: COLORS.body, fontSize: 10 } },
          ],
          { x: 0.6, y: startY + i * h, w: 6.2, h, fontFace: 'Calibri', valign: 'top' }
        );
      });
    }
  }

  // Right column: contact path
  s.addText('CONTACT PATH', {
    x: 7.0, y: 1.6, w: 5.8, h: 0.3,
    color: COLORS.muted, fontSize: 10, bold: true, charSpacing: 3,
  });
  if (pathResolved.length === 0) {
    s.addText('No path set yet.', {
      x: 7.0, y: 1.95, w: 5.8, h: 0.4,
      color: COLORS.muted, fontSize: 12, italic: true,
    });
  } else {
    const rowH = 0.55;
    pathResolved.slice(0, 7).forEach((c, i) => {
      const y = 1.95 + i * rowH;
      s.addShape(pptx.ShapeType.ellipse, {
        x: 7.0, y: y + 0.1, w: 0.3, h: 0.3,
        fill: { color: c.deal_role === 'champion' ? COLORS.accent : COLORS.chipBg },
        line: { color: COLORS.rule, width: 0.5 },
      });
      s.addText(String(i + 1), {
        x: 7.0, y: y + 0.1, w: 0.3, h: 0.3,
        color: c.deal_role === 'champion' ? 'FFFFFF' : COLORS.ink,
        fontSize: 10, bold: true, align: 'center', valign: 'middle',
      });
      s.addText(
        [
          { text: c.name, options: { bold: true, color: COLORS.ink, fontSize: 12 } },
          { text: c.title ? `  ${c.title}` : '', options: { color: COLORS.muted, fontSize: 10 } },
          { text: `   · ${c.deal_role}/${c.stance}`, options: { color: COLORS.muted, fontSize: 9, italic: true } },
        ],
        { x: 7.4, y: y, w: 5.4, h: rowH, fontFace: 'Calibri', valign: 'middle' }
      );
    });
  }
}

function addMovesSlides(pptx, moves) {
  // Chunk 3 moves per slide so each move has room to breathe.
  const chunks = [];
  for (let i = 0; i < moves.length; i += 3) chunks.push(moves.slice(i, i + 3));

  chunks.forEach((chunk, chunkIdx) => {
    const s = pptx.addSlide();
    s.background = { color: COLORS.bg };
    const suffix = chunks.length > 1 ? ` (${chunkIdx + 1}/${chunks.length})` : '';
    addSectionHeader(s, `Sequenced moves${suffix}`, 'The playbook, in order');

    const rowH = 1.7;
    const startY = 1.6;
    chunk.forEach((m, i) => {
      const y = startY + i * rowH;
      const tag = ACTOR_TAG[m.actor_type] || ACTOR_TAG.ae;

      // Step circle
      s.addShape(pptx.ShapeType.ellipse, {
        x: 0.6, y: y + 0.1, w: 0.55, h: 0.55,
        fill: { color: COLORS.ink }, line: { color: COLORS.ink },
      });
      s.addText(String(m.step ?? i + 1), {
        x: 0.6, y: y + 0.1, w: 0.55, h: 0.55,
        color: 'FFFFFF', fontSize: 18, bold: true, align: 'center', valign: 'middle',
      });

      // Actor tag
      s.addText(tag.label, {
        x: 1.35, y: y + 0.05, w: 3.0, h: 0.28,
        color: tag.color, fontSize: 9, bold: true, charSpacing: 3,
      });

      // Actor + channel + day
      s.addText(
        [
          { text: m.actor || '', options: { bold: true, color: COLORS.ink, fontSize: 14 } },
          { text: `   ${m.channel || ''} · day ${m.days_from_now ?? '?'}`, options: { color: COLORS.muted, fontSize: 11 } },
        ],
        { x: 1.35, y: y + 0.33, w: 11.5, h: 0.35, fontFace: 'Calibri' }
      );

      // Ask + rationale
      s.addText(m.ask || '', {
        x: 1.35, y: y + 0.75, w: 11.5, h: 0.45,
        color: COLORS.body, fontSize: 12, fontFace: 'Calibri',
      });
      if (m.rationale) {
        s.addText(m.rationale, {
          x: 1.35, y: y + 1.2, w: 11.5, h: 0.4,
          color: COLORS.muted, fontSize: 10, italic: true, fontFace: 'Calibri',
        });
      }

      // Artifact indicator
      const hasArtifact = m.artifact && m.artifact.content && String(m.artifact.content).trim();
      if (hasArtifact) {
        s.addText('📋 artifact on next slide', {
          x: 11.2, y: y + 0.05, w: 1.7, h: 0.28,
          color: COLORS.accent, fontSize: 9, bold: true, align: 'right',
        });
      }

      // Divider
      s.addShape(pptx.ShapeType.line, {
        x: 0.6, y: y + rowH - 0.05, w: 12.2, h: 0,
        line: { color: COLORS.rule, width: 0.75 },
      });
    });
  });
}

function addArtifactSlide(pptx, move) {
  const s = pptx.addSlide();
  s.background = { color: COLORS.bg };

  const typeLabel = ARTIFACT_TYPE_LABEL[move.artifact.type] || 'Artifact';
  const forChampion = move.artifact.for_actor === 'champion';
  const accent = forChampion ? COLORS.accent : COLORS.aeAccent;

  // Accent bar on the left — visual cue this is a champion-voice slide
  s.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 0.15, h: 7.5,
    fill: { color: accent }, line: { color: accent },
  });

  addSectionHeader(s, `Step ${move.step}: ${typeLabel}`,
    forChampion ? 'For the champion to paste — champion voice' : 'For you to carry — AE voice');

  // The artifact itself, in monospace-ish feel so it reads like a draft
  s.addShape(pptx.ShapeType.rect, {
    x: 0.6, y: 1.6, w: 12.2, h: 5.4,
    fill: { color: forChampion ? COLORS.accentSoft : COLORS.chipBg },
    line: { color: COLORS.rule, width: 0.5 },
  });
  s.addText(move.artifact.content, {
    x: 0.8, y: 1.75, w: 11.8, h: 5.15,
    color: COLORS.ink, fontSize: 13, fontFace: 'Calibri', valign: 'top',
  });

  // Footer with actor + channel context
  s.addText(
    [
      { text: `${move.actor || ''} `, options: { color: COLORS.muted, fontSize: 10 } },
      { text: `· ${move.channel || ''} · day ${move.days_from_now ?? '?'}`, options: { color: COLORS.muted, fontSize: 10, italic: true } },
    ],
    { x: 0.6, y: 7.1, w: 12.2, h: 0.3, fontFace: 'Calibri' }
  );
}

function addStakeholdersSlide(pptx, narratives) {
  const s = pptx.addSlide();
  s.background = { color: COLORS.bg };
  addSectionHeader(s, 'Stakeholder narratives', 'What each person needs to believe — in champion voice');

  const entries = Object.entries(narratives).slice(0, 6);
  const rowH = 5.2 / Math.max(entries.length, 1);
  entries.forEach(([name, text], i) => {
    const y = 1.6 + i * rowH;
    s.addText(name, {
      x: 0.6, y, w: 3.2, h: rowH - 0.1,
      color: COLORS.accent, fontSize: 14, bold: true, fontFace: 'Calibri', valign: 'top',
    });
    s.addText(text, {
      x: 4.0, y, w: 8.8, h: rowH - 0.1,
      color: COLORS.body, fontSize: 13, fontFace: 'Calibri', valign: 'top',
    });
  });
}

function addClosingSlide(pptx, exp) {
  const s = pptx.addSlide();
  s.background = { color: COLORS.bg };
  addSectionHeader(s, 'Risks, internal ask, positioning', 'Coach notes');

  let y = 1.6;

  if (exp.internal_ask) {
    s.addText('INTERNAL ASK', {
      x: 0.6, y, w: 12.2, h: 0.3,
      color: COLORS.muted, fontSize: 10, bold: true, charSpacing: 3,
    });
    s.addText(exp.internal_ask, {
      x: 0.6, y: y + 0.3, w: 12.2, h: 0.7,
      color: COLORS.ink, fontSize: 13, fontFace: 'Calibri',
    });
    y += 1.15;
  }

  if (Array.isArray(exp.risks) && exp.risks.length > 0) {
    s.addText('RISKS', {
      x: 0.6, y, w: 12.2, h: 0.3,
      color: COLORS.risk, fontSize: 10, bold: true, charSpacing: 3,
    });
    const bullets = exp.risks.map((r) => ({ text: r, options: { bullet: { code: '25A0' } } }));
    s.addText(bullets, {
      x: 0.6, y: y + 0.3, w: 12.2, h: 1.6,
      color: COLORS.body, fontSize: 12, fontFace: 'Calibri', paraSpaceAfter: 6, valign: 'top',
    });
    y += 2.0;
  }

  if (Array.isArray(exp.positioning_hooks) && exp.positioning_hooks.length > 0) {
    s.addText('POSITIONING HOOKS', {
      x: 0.6, y, w: 12.2, h: 0.3,
      color: COLORS.muted, fontSize: 10, bold: true, charSpacing: 3,
    });
    // Render as chips (rectangles)
    let cx = 0.6;
    let cy = y + 0.35;
    exp.positioning_hooks.forEach((hook) => {
      const estW = Math.min(6.0, 0.3 + hook.length * 0.09);
      if (cx + estW > 12.8) { cx = 0.6; cy += 0.5; }
      s.addShape(pptx.ShapeType.roundRect, {
        x: cx, y: cy, w: estW, h: 0.4,
        fill: { color: COLORS.chipBg }, line: { color: COLORS.rule, width: 0.5 },
        rectRadius: 0.1,
      });
      s.addText(hook, {
        x: cx, y: cy, w: estW, h: 0.4,
        color: COLORS.ink, fontSize: 10, align: 'center', valign: 'middle', fontFace: 'Calibri',
      });
      cx += estW + 0.15;
    });
  }
}

// Shared slide header: small tag + large title. Keeps slides visually
// anchored so a deck skimmed in Google Slides feels like one doc.
function addSectionHeader(s, title, sub) {
  s.addText(title, {
    x: 0.6, y: 0.4, w: 12.2, h: 0.7,
    color: COLORS.ink, fontSize: 28, bold: true, fontFace: 'Calibri',
  });
  if (sub) {
    s.addText(sub, {
      x: 0.6, y: 1.05, w: 12.2, h: 0.4,
      color: COLORS.muted, fontSize: 12, italic: true, fontFace: 'Calibri',
    });
  }
}
