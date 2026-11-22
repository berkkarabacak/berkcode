import Anthropic from '@anthropic-ai/sdk';
import { getSetting } from './settings.js';

const FALLBACK_MODELS = [
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
  { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' },
];

let modelCache = { at: 0, key: '', models: null };

function client(apiKey) {
  return new Anthropic({ apiKey, maxRetries: 1, timeout: 20_000 });
}

function explain(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'The API key was rejected (invalid or revoked). Copy a fresh key from the Claude Console.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'The API key does not have permission for this request.';
  if (err instanceof Anthropic.RateLimitError) return 'The key works, but the API is rate limiting requests right now.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach api.anthropic.com. Check the internet connection.';
  return err?.message ?? String(err);
}

/** Makes one minimal API call (list one model) to check the key. */
export async function testKey(apiKey) {
  if (!apiKey) return { ok: false, message: 'No API key entered.' };
  if (!apiKey.startsWith('sk-ant-')) return { ok: false, message: 'This does not look like a Claude API key (it should start with "sk-ant-").' };
  try {
    await client(apiKey).models.list({ limit: 1 });
    return { ok: true, message: 'The key works.' };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return { ok: true, message: explain(err) };
    return { ok: false, message: explain(err) };
  }
}

/** Picks a sensible default: Sonnet 5.5 if offered, otherwise the newest Sonnet, otherwise the newest model. */
export function pickDefaultModel(models) {
  const ids = models.map((m) => m.id);
  if (ids.includes('claude-sonnet-5-5')) return 'claude-sonnet-5-5';
  return ids.find((id) => id.includes('sonnet')) ?? ids[0] ?? null;
}

export async function listModels() {
  const apiKey = getSetting('api_key');
  if (!apiKey) return { models: FALLBACK_MODELS, source: 'default' };
  if (modelCache.models && modelCache.key === apiKey && Date.now() - modelCache.at < 3600_000) {
    return { models: modelCache.models, source: 'api' };
  }
  try {
    const models = [];
    for await (const m of client(apiKey).models.list({ limit: 100 })) models.push({ id: m.id, display_name: m.display_name });
    modelCache = { at: Date.now(), key: apiKey, models };
    return { models, source: 'api' };
  } catch (err) {
    return { models: FALLBACK_MODELS, source: 'default', error: explain(err) };
  }
}
