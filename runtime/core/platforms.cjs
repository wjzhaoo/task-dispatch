'use strict';

// [AI-added] 2026-09-15 20:30
// Desktop host providers are distinct from headless execution profiles. Keep
// aliases, role eligibility and continuation capability in one place.
const ALIASES = Object.freeze({
  qodercn: 'qoder',
  'qoder-cn': 'qoder',
  codeartsdoer: 'codearts'
});
const ROLE_PROVIDERS = Object.freeze({
  brain: Object.freeze(['codex', 'mimo', 'qoder']),
  reviewer: Object.freeze(['codex', 'mimo', 'qoder'])
});
const WAKE_PROVIDERS = Object.freeze(['codex', 'mimo', 'qoder', 'codearts']);
const DISCOVERY_PROVIDERS = Object.freeze(['mimo', 'codearts']);
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
    throw Error(`${role} only supports codex, mimo or qoder host providers`);
  }
  return normalized;
}
function discoveryProviders(provider) {
  const normalized = normalizeProvider(provider);
  return normalized ? [normalized] : [...DISCOVERY_PROVIDERS];
}

module.exports = {ALIASES,ROLE_PROVIDERS,WAKE_PROVIDERS,DISCOVERY_PROVIDERS,normalizeProvider,continuationMode,assertRoleProvider,discoveryProviders};
