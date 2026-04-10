const aiStudioNanoBananaPro = require('./ai_studio_nano_banana_pro');
const kieNanoBananaPro = require('./kie_nano_banana_pro');

const LEGACY_GEMINI_ID = 'gemini';

const providers = {
  [aiStudioNanoBananaPro.id]: aiStudioNanoBananaPro,
  [kieNanoBananaPro.id]: kieNanoBananaPro
};

const DEFAULT_ID = aiStudioNanoBananaPro.id;

function normalizeProviderId(providerId) {
  if (!providerId) return null;
  if (providerId === LEGACY_GEMINI_ID) return aiStudioNanoBananaPro.id;
  return providerId;
}

function getProvider(providerId) {
  const normalized = normalizeProviderId(providerId);
  const id = normalized && providers[normalized] ? normalized : DEFAULT_ID;
  return providers[id];
}

function listProviders() {
  return Object.values(providers).map((p) => ({
    id: p.id,
    label: p.label,
    vendor: p.vendor
  }));
}

function isValidProviderId(id) {
  if (!id) return false;
  const n = normalizeProviderId(id);
  return Boolean(n && providers[n]);
}

/** Distinct `vendor` values for job limits / settings (stable order). */
function listUniqueVendors() {
  const s = new Set();
  for (const p of Object.values(providers)) {
    if (p && p.vendor) s.add(p.vendor);
  }
  return Array.from(s).sort();
}

module.exports = {
  getProvider,
  listProviders,
  listUniqueVendors,
  isValidProviderId,
  DEFAULT_ID,
  normalizeProviderId,
  LEGACY_GEMINI_ID
};
