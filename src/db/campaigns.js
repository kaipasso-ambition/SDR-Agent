import { query } from './index.js';

export async function listCampaigns(userId) {
  const { rows } = await query(
    `SELECT c.*,
       (SELECT COUNT(*) FROM campaign_prospects cp WHERE cp.campaign_id = c.id)::int AS roster_count,
       (SELECT COUNT(*) FROM campaign_prospects cp WHERE cp.campaign_id = c.id AND cp.special_invite)::int AS invite_count,
       (SELECT COUNT(*) FROM approval_queue aq WHERE aq.campaign_id = c.id AND aq.status = 'pending')::int AS pending_draft_count
     FROM campaigns c
     WHERE ($1::uuid IS NULL OR c.owner_user_id = $1)
     ORDER BY c.created_at DESC`,
    [userId]
  );
  return rows;
}

export async function createCampaign(data) {
  const {
    name, goal = null, description = null,
    event_date = null, event_url = null,
    special_invite_description = null, special_invite_capacity = null,
    owner_user_id,
  } = data;
  const { rows } = await query(
    `INSERT INTO campaigns
       (name, goal, description, event_date, event_url,
        special_invite_description, special_invite_capacity, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [name, goal, description, event_date, event_url,
     special_invite_description, special_invite_capacity, owner_user_id]
  );
  return rows[0];
}

export async function getCampaignById(id, userId = null) {
  const { rows } = await query(
    `SELECT * FROM campaigns WHERE id = $1 AND ($2::uuid IS NULL OR owner_user_id = $2 OR owner_user_id IS NULL)`,
    [id, userId]
  );
  return rows[0] || null;
}

export async function getCampaignRoster(campaignId) {
  const { rows } = await query(
    `SELECT p.id, p.company, p.domain, p.contact_name, p.contact_title, p.contact_email,
            cp.special_invite, cp.added_at,
            (SELECT COUNT(*) FROM approval_queue aq
               WHERE aq.prospect_id = p.id AND aq.campaign_id = $1)::int AS draft_count
       FROM campaign_prospects cp
       JOIN prospects p ON p.id = cp.prospect_id
      WHERE cp.campaign_id = $1
      ORDER BY p.company ASC`,
    [campaignId]
  );
  return rows;
}

export async function addProspectToCampaign(campaignId, prospectId, { special_invite = false } = {}) {
  await query(
    `INSERT INTO campaign_prospects (campaign_id, prospect_id, special_invite)
     VALUES ($1, $2, $3)
     ON CONFLICT (campaign_id, prospect_id) DO NOTHING`,
    [campaignId, prospectId, special_invite]
  );
}

export async function setSpecialInvites(campaignId, prospectIds) {
  // First, clear all invite flags in this campaign
  await query(
    `UPDATE campaign_prospects SET special_invite = FALSE WHERE campaign_id = $1`,
    [campaignId]
  );
  if (prospectIds.length === 0) return;
  await query(
    `UPDATE campaign_prospects
        SET special_invite = TRUE
      WHERE campaign_id = $1 AND prospect_id = ANY($2::uuid[])`,
    [campaignId, prospectIds]
  );
}

export async function countSpecialInvites(campaignId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM campaign_prospects WHERE campaign_id = $1 AND special_invite = TRUE`,
    [campaignId]
  );
  return rows[0].n;
}
