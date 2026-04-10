/**
 * Per-vendor concurrency + sliding-window rate limiting for generate-image jobs.
 * @typedef {{ maxConcurrent: number, maxStartsPerWindow: number, windowMs: number }} VendorLimits
 */

/** @type {Map<string, { active: number, starts: number[], waitConc: Array<() => void> }>} */
const slots = new Map();

function getSlot(vendor) {
  const key = vendor || 'default';
  if (!slots.has(key)) {
    slots.set(key, { active: 0, starts: [], waitConc: [] });
  }
  return slots.get(key);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} vendor
 * @param {VendorLimits} limits
 */
async function acquireVendorJob(vendor, limits) {
  const s = getSlot(vendor);
  const { maxConcurrent, maxStartsPerWindow, windowMs } = limits;

  for (;;) {
    const now = Date.now();
    s.starts = s.starts.filter((t) => now - t < windowMs);

    if (s.starts.length >= maxStartsPerWindow) {
      const oldest = s.starts[0];
      const waitMs = Math.max(1, windowMs - (now - oldest) + 1);
      await sleep(waitMs);
      continue;
    }

    if (s.active < maxConcurrent) {
      s.active += 1;
      s.starts.push(Date.now());
      return;
    }

    await new Promise((resolve) => {
      s.waitConc.push(resolve);
    });
  }
}

/**
 * @param {string} vendor
 */
function releaseVendorJob(vendor) {
  const s = getSlot(vendor);
  s.active = Math.max(0, s.active - 1);
  const next = s.waitConc.shift();
  if (next) next();
}

/**
 * @param {string} vendor
 * @param {VendorLimits} limits
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withVendorJobGate(vendor, limits, fn) {
  await acquireVendorJob(vendor, limits);
  try {
    return await fn();
  } finally {
    releaseVendorJob(vendor);
  }
}

module.exports = {
  acquireVendorJob,
  releaseVendorJob,
  withVendorJobGate
};
