import { getSetting } from './settings.js';

const KEY_PATTERN = /sk-ant-[A-Za-z0-9_\-]*/g;

/** Removes anything that looks like an Anthropic API key, plus the configured key itself. */
export function redact(text) {
  if (text == null) return text;
  let out = String(text).replace(KEY_PATTERN, 'sk-ant-[REDACTED]');
  const key = getSetting('api_key');
  if (key && key.length > 8 && out.includes(key)) out = out.split(key).join('[REDACTED]');
  return out;
}
