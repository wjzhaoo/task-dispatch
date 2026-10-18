'use strict';

// [AI-added] 2026-09-15 20:30
// Keep host aliases, role eligibility and continuation capability in one place.
const ALIASES = Object.freeze({
  codeartsdoer: 'codearts',
  qodercn: 'qoder',
  'qoder-cn': 'qoder',
  'open-code': 'opencode'
});
const WAKE_PROVIDERS = Object.freeze(['codex', 'mimo', 'qoder', 'codearts', 'opencode', 'dsh']);
const ROLE_PROVIDERS = Object.freeze({ brain: WAKE_PROVIDERS, reviewer: WAKE_PROVIDERS });
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function normalizeProvider(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw Error('Invalid host provider');
  const provider = value.toLowerCase();
  if(provider==='auto')throw Error('Provider auto is not allowed; specify the actual host provider');
  if (!PROVIDER_PATTERN.test(provider)) throw Error('Invalid host provider');
  return ALIASES[provider] || provider;
}
function continuationMode(provider) { return WAKE_PROVIDERS.includes(normalizeProvider(provider)) ? 'wake' : 'wait'; }
function assertRoleProvider(role, provider) {
  const normalized = normalizeProvider(provider);
  if (normalized && ROLE_PROVIDERS[role] && !ROLE_PROVIDERS[role].includes(normalized)) {
    const providers = ROLE_PROVIDERS[role];
    throw Error(`${role} only supports ${providers.slice(0, -1).join(', ')} or ${providers.at(-1)} host providers`);
  }
  return normalized;
}
module.exports = {ALIASES,ROLE_PROVIDERS,WAKE_PROVIDERS,normalizeProvider,continuationMode,assertRoleProvider};
