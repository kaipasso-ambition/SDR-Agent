import Anthropic from '@anthropic-ai/sdk';

const { RateLimitError, APIError } = Anthropic;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isSpendLimit(err) {
  const msg = err?.message || '';
  return msg.includes('usage limit') || msg.includes('spending limit') || msg.includes('budget');
}

export async function callWithRetry(client, params, opts = {}) {
  const { timeout, maxRetries = 3 } = opts;
  const delays = [2000, 4000, 8000, 16000];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await client.messages.create(params, timeout ? { timeout } : undefined);
    } catch (err) {
      const isRateLimit = err instanceof RateLimitError ||
        (err instanceof APIError && err.status === 429);
      const isOverloaded = err instanceof APIError && err.status === 529;

      if (isRateLimit && isSpendLimit(err)) throw err;

      const retryable = isRateLimit || isOverloaded;
      if (!retryable || attempt >= maxRetries) throw err;

      const delay = delays[attempt] || 16000;
      console.log(`[api_retry] ${isRateLimit ? '429' : '529'} — retry ${attempt + 1}/${maxRetries} in ${delay}ms`);
      await sleep(delay);
    }
  }
}
