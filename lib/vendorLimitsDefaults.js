/**
 * Default job limits + poll interval per vendor key (used by Settings + main merge).
 * @typedef {{ maxConcurrent: number, maxStartsPerWindow: number, windowMs: number, pollIntervalMs: number }} VendorLimitEntry
 */

/** @type {VendorLimitEntry} */
const FALLBACK_DEFAULT = {
  maxConcurrent: 20,
  maxStartsPerWindow: 20,
  windowMs: 10000,
  pollIntervalMs: 2500
};

/** @type {Record<string, VendorLimitEntry>} */
const DEFAULT_VENDOR_JOB_LIMITS = {
  kie_ai: {
    maxConcurrent: 100,
    maxStartsPerWindow: 20,
    windowMs: 10000,
    pollIntervalMs: 2500
  },
  ai_studio: {
    maxConcurrent: 50,
    maxStartsPerWindow: 60,
    windowMs: 60000,
    pollIntervalMs: 2500
  }
};

const MAX_CONCURRENT_CAP = 500;
const MAX_STARTS_CAP = 10000;
const MIN_WINDOW_MS = 1000;
const MAX_WINDOW_MS = 3600000;
const MIN_POLL_MS = 500;
const MAX_POLL_MS = 120000;

/**
 * @param {Partial<Record<string, Partial<VendorLimitEntry>>>} [saved]
 * @param {string[]} vendorKeys — unique vendor strings from registry
 * @returns {Record<string, VendorLimitEntry>}
 */
function mergeVendorJobLimits(saved, vendorKeys) {
  const keys = vendorKeys.length ? vendorKeys : Object.keys(DEFAULT_VENDOR_JOB_LIMITS);
  const out = {};
  for (const v of keys) {
    const base = DEFAULT_VENDOR_JOB_LIMITS[v] || FALLBACK_DEFAULT;
    const row = { ...base, ...(saved && saved[v] ? saved[v] : {}) };
    out[v] = clampVendorLimitEntry(row);
  }
  return out;
}

/**
 * @param {VendorLimitEntry} row
 * @returns {VendorLimitEntry}
 */
function clampVendorLimitEntry(row) {
  return {
    maxConcurrent: clampInt(row.maxConcurrent, 1, MAX_CONCURRENT_CAP, 20),
    maxStartsPerWindow: clampInt(row.maxStartsPerWindow, 1, MAX_STARTS_CAP, 20),
    windowMs: clampInt(row.windowMs, MIN_WINDOW_MS, MAX_WINDOW_MS, 10000),
    pollIntervalMs: clampInt(row.pollIntervalMs, MIN_POLL_MS, MAX_POLL_MS, 2500)
  };
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(max, Math.max(min, Math.round(x)));
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
function validateVendorJobLimitsPayload(raw) {
  if (raw == null || typeof raw !== 'object') return false;
  for (const v of Object.keys(raw)) {
    const row = raw[v];
    if (row == null || typeof row !== 'object') return false;
    const c = clampVendorLimitEntry({
      maxConcurrent: row.maxConcurrent,
      maxStartsPerWindow: row.maxStartsPerWindow,
      windowMs: row.windowMs,
      pollIntervalMs: row.pollIntervalMs
    });
    if (c.maxConcurrent < 1 || c.maxStartsPerWindow < 1) return false;
  }
  return true;
}

module.exports = {
  DEFAULT_VENDOR_JOB_LIMITS,
  FALLBACK_DEFAULT,
  mergeVendorJobLimits,
  clampVendorLimitEntry,
  validateVendorJobLimitsPayload,
  MAX_CONCURRENT_CAP,
  MAX_STARTS_CAP,
  MIN_WINDOW_MS,
  MAX_WINDOW_MS,
  MIN_POLL_MS,
  MAX_POLL_MS
};
