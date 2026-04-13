import { Router } from 'express';
import {
  getPendingDrafts,
  getPendingReplies,
  setApprovalStatus,
  setReplyStatus,
  updateDraft,
} from '../queue/approval_queue.js';
import { getProspectById } from '../db/prospects.js';

export const router = Router();

router.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Outbound draft queue
router.get('/queue/drafts', async (_req, res, next) => {
  try {
    res.json(await getPendingDrafts());
  } catch (err) {
    next(err);
  }
});

router.post('/queue/drafts/:id/approve', async (req, res, next) => {
  try {
    res.json(await setApprovalStatus(req.params.id, 'approved'));
  } catch (err) {
    next(err);
  }
});

router.post('/queue/drafts/:id/reject', async (req, res, next) => {
  try {
    res.json(await setApprovalStatus(req.params.id, 'rejected'));
  } catch (err) {
    next(err);
  }
});

router.patch('/queue/drafts/:id', async (req, res, next) => {
  try {
    res.json(await updateDraft(req.params.id, req.body.draft));
  } catch (err) {
    next(err);
  }
});

// Reply queue
router.get('/queue/replies', async (_req, res, next) => {
  try {
    res.json(await getPendingReplies());
  } catch (err) {
    next(err);
  }
});

router.post('/queue/replies/:id/approve', async (req, res, next) => {
  try {
    res.json(await setReplyStatus(req.params.id, 'approved'));
  } catch (err) {
    next(err);
  }
});

router.post('/queue/replies/:id/reject', async (req, res, next) => {
  try {
    res.json(await setReplyStatus(req.params.id, 'rejected'));
  } catch (err) {
    next(err);
  }
});

// Prospect lookup
router.get('/prospects/:id', async (req, res, next) => {
  try {
    const p = await getProspectById(req.params.id);
    if (!p) return res.status(404).json({ error: 'not_found' });
    res.json(p);
  } catch (err) {
    next(err);
  }
});
