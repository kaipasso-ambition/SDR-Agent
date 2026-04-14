// Hard-coded 10-prospect pilot batch.
//
// Hand-picked from Kai's and Colin's Salesforce books after a manual signal
// hunt (transportation / debt consolidation / telecom — verticals where
// Ambition wins and AI-tool adoption is still low).
//
// ORDERED BY SIGNAL STRENGTH, alternating owners — so a `?limit=N` run picks
// the N strongest picks while keeping Kai/Colin coverage roughly balanced.
// The researcher still runs fresh; signal_note is operator-facing only and is
// NOT passed into the research pass.
export const PILOT_BATCH = [
  // --- Top tier: freshest, most specific CRO / sales-leader signals ---
  {
    company: 'Lumen',
    domain: 'lumen.com',
    owner_name: 'Colin',
    signal_note: 'New CRO Jeffery Sharritts effective Feb 4, 2026 (replaced Ashley Haynes-Gaspar). Strongest signal in batch.',
  },
  {
    company: 'iHeartMedia',
    domain: 'iheart.com',
    owner_name: 'Kai',
    signal_note: 'New EVP Marketing Jamie Cutburth (Mar 31, 2026) + active sales restructuring Apr 8, 2026 under Julie Donohue.',
  },
  {
    company: 'Zayo Group',
    domain: 'zayo.com',
    owner_name: 'Colin',
    signal_note: 'New Enterprise CRO Chris Ranalli Mar 3, 2026; Zayo split the CRO role — Brian Daniels got Infrastructure.',
  },
  {
    company: 'J.B. Hunt Transport Services',
    domain: 'jbhunt.com',
    owner_name: 'Kai',
    signal_note: 'Q1 2026 earnings Apr 15, 2026. Spencer Frazier EVP Sales & Marketing; CEO Shelley Simpson (Jul 2024).',
  },

  // --- Mid tier: solid dated signals, a half-step off the top ---
  {
    company: 'Echo Global Logistics',
    domain: 'echo.com',
    owner_name: 'Colin',
    signal_note: 'Acquired ITS Logistics Jan 21, 2026 — two sales orgs integrating.',
  },
  {
    company: 'Kuehne+Nagel',
    domain: 'kuehne-nagel.com',
    owner_name: 'Kai',
    signal_note: 'New head of road-logistics Sören Schmidt effective May 1, 2026 (from DSV).',
  },
  {
    company: 'Landstar System',
    domain: 'landstar.com',
    owner_name: 'Colin',
    signal_note: 'Q4 2025 earnings miss + broad leadership refresh; new CHRO Terri Lewis Feb 2026; activist-flavored board additions.',
  },
  {
    company: 'Triumph Financial',
    domain: 'tfin.com',
    owner_name: 'Kai',
    signal_note: 'New transportation exec bench (Kim Fisk Pres. of Factoring, David Vielehr, Todd Ritterbusch); Q1 2026 earnings Apr 22.',
  },

  // --- Softer signal tier: worth running but expect lower fit scores ---
  {
    company: 'National Debt Relief',
    domain: 'nationaldebtrelief.com',
    owner_name: 'Colin',
    signal_note: 'Active VP of Sales req with 5/1/2026 start date; Forbes 2026 "Best Debt Relief" award; 1,238 employees.',
  },
  {
    company: 'GreenSky',
    domain: 'greenskycredit.com',
    owner_name: 'Kai',
    signal_note: 'CEO Ritesh Gupta since Jul 1, 2025 under Sixth Street; post-Goldman rebuild. Softer signal.',
  },
];
