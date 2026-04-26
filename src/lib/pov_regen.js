import { getAccountBundle } from '../db/accounts_registry.js';
import { getSignalsForAccount } from '../db/signals.js';
import { getAccountIntel, setIntelRunning, setIntelResult, setIntelFailed } from '../db/account_intel.js';
import { generateAccountPov } from '../agents/account_pov.js';

export async function regenerateAccountPov(accountId) {
  try {
    const bundle = await getAccountBundle(accountId);
    if (!bundle) return;
    const [signals, intel] = await Promise.all([
      getSignalsForAccount(accountId, { limit: 10 }),
      getAccountIntel(accountId),
    ]);
    const prospects = intel.prospect_scan?.status === 'completed'
      ? (intel.prospect_scan.result?.prospects || [])
      : [];
    const useCaseFit = intel.use_case_fit?.status === 'completed' ? intel.use_case_fit.result : null;
    const industryInsight = intel.industry_insight?.status === 'completed' ? intel.industry_insight.result : null;

    await setIntelRunning(accountId, 'account_pov');
    const out = await generateAccountPov({
      account: bundle.account,
      signals,
      prospects,
      useCaseFit,
      industryInsight,
    });
    if (out.error || !out.result) {
      await setIntelFailed(accountId, 'account_pov', out.error || 'no_result');
      return;
    }
    await setIntelResult(accountId, 'account_pov', out.result);
    console.log(`[pov] ${accountId} — ${out.elapsed_ms}ms, priority=${out.result.priority}`);
  } catch (err) {
    console.error(`[pov] ${accountId} failed:`, err);
    try { await setIntelFailed(accountId, 'account_pov', err.message || String(err)); } catch (_) {}
  }
}
