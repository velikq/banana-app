const { uploadReferenceImages } = require('../lib/kieReferenceUpload');

const KIE_JOBS_BASE = 'https://api.kie.ai';
const DEFAULT_POLL_MAX_MS = 600000;

const ALLOWED_RES = new Set(['1K', '2K', '4K']);
const ALLOWED_RATIO = new Set([
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', 'auto'
]);

class KiePollTimeoutError extends Error {
  /**
   * @param {string} message
   * @param {string} taskId
   */
  constructor(message, taskId) {
    super(message);
    this.name = 'KiePollTimeoutError';
    this.kieTaskId = taskId;
  }
}

function buildRequestParts() {
  return [];
}

function mapResolution(r) {
  return ALLOWED_RES.has(r) ? r : '1K';
}

function mapAspectRatio(ratio) {
  return ALLOWED_RATIO.has(ratio) ? ratio : '1:1';
}

async function createTask(apiKey, body) {
  const res = await fetch(`${KIE_JOBS_BASE}/api/v1/jobs/createTask`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (json.code !== 200 || !json.data?.taskId) {
    throw new Error(json.msg || `Kie createTask failed (${res.status})`);
  }
  return json.data.taskId;
}

/**
 * One GET recordInfo call.
 * @returns {Promise<{ ok: true, data: object } | { ok: false, msg: string, status?: number }>}
 */
async function fetchKieTaskRecordOnce(apiKey, taskId) {
  const res = await fetch(
    `${KIE_JOBS_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
  const json = await res.json().catch(() => ({}));
  if (json.code !== 200 || json.data == null) {
    return { ok: false, msg: String(json.msg || res.status), status: res.status };
  }
  return { ok: true, data: json.data };
}

/**
 * @param {object} data — json.data from recordInfo
 * @returns {string | null} image URL
 */
function resultImageUrlFromRecordData(data) {
  const { state, resultJson } = data;
  if (state !== 'success' || !resultJson) return null;
  let parsed;
  try {
    parsed = JSON.parse(resultJson);
  } catch {
    throw new Error('Kie: invalid resultJson');
  }
  const url = parsed.resultUrls?.[0];
  if (!url) throw new Error('Kie: no resultUrls in result');
  return url;
}

/**
 * @param {string} apiKey
 * @param {string} taskId
 * @param {{ log?: Function, warn?: Function }} logger
 * @param {{ pollIntervalMs?: number, maxPollMs?: number }} [opts]
 */
async function pollUntilImageUrl(apiKey, taskId, logger, opts = {}) {
  const pollIntervalMs = Math.max(500, Number(opts.pollIntervalMs) || 2500);
  const maxPollMs = Math.max(1000, Number(opts.maxPollMs) || DEFAULT_POLL_MAX_MS);
  const start = Date.now();
  let delay = pollIntervalMs;

  while (Date.now() - start < maxPollMs) {
    await new Promise((r) => setTimeout(r, delay));

    const rec = await fetchKieTaskRecordOnce(apiKey, taskId);
    if (!rec.ok) {
      logger.warn?.('Kie recordInfo:', rec.msg);
      delay = Math.min(delay + 400, 12000);
      continue;
    }

    const { state, resultJson, failMsg } = rec.data;

    if (state === 'success' && resultJson) {
      return resultImageUrlFromRecordData(rec.data);
    }

    if (state === 'fail') {
      throw new Error(failMsg || 'Kie generation failed');
    }

    logger.log?.(`Kie task ${taskId}: ${state}`);
    delay = Math.min(Math.max(pollIntervalMs, delay), 8000);
  }

  throw new KiePollTimeoutError('Kie task timed out', taskId);
}

async function downloadResult(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download Kie result (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
  return { buffer: buf, mimeType: ct };
}

/**
 * @param {object} ctx
 * @param {string} ctx.apiKey
 * @param {string} ctx.vendor
 * @param {import('../lib/kieUploadCacheSqlite').KieUploadCacheSqlite | null} [ctx.kieUploadCache]
 * @param {string} ctx.prompt
 * @param {string} ctx.resolution
 * @param {string} ctx.ratio
 * @param {string} ctx.inputDir
 * @param {Array<{ hash: string, mimeType: string, extension?: string }>} ctx.referenceImages
 * @param {{ log?: Function, error?: Function, warn?: Function }} [ctx.logger]
 * @param {(label: string, data: unknown) => void} [ctx.sendDebug]
 * @param {(msg: string) => void} [ctx.sendRequestLog]
 * @param {number} [ctx.pollIntervalMs]
 */
async function generateImage(ctx) {
  const {
    apiKey,
    vendor,
    kieUploadCache,
    prompt,
    resolution,
    ratio,
    inputDir,
    referenceImages,
    logger = {},
    sendDebug,
    sendRequestLog,
    pollIntervalMs
  } = ctx;

  if (!apiKey) {
    throw new Error('Kie.ai API key is missing (set KIE_AI_API_KEY in .env or Settings)');
  }

  const imageUrls = await uploadReferenceImages({
    apiKey,
    vendor: vendor || 'kie_ai',
    inputDir,
    referenceImages,
    logger,
    cacheStore: kieUploadCache || null,
    sendRequestLog
  });

  const body = {
    model: 'nano-banana-pro',
    input: {
      prompt,
      image_input: imageUrls,
      aspect_ratio: mapAspectRatio(ratio),
      resolution: mapResolution(resolution),
      output_format: 'png'
    }
  };

  if (sendDebug) {
    sendDebug('Kie createTask body:', JSON.stringify(body, null, 2));
  }

  const taskId = await createTask(apiKey, body);
  sendRequestLog?.(`Kie generation request sent (taskId=${taskId})`);
  logger.log?.(`Kie task created: ${taskId}`);

  const resultUrl = await pollUntilImageUrl(apiKey, taskId, logger, { pollIntervalMs });
  return downloadResult(resultUrl);
}

module.exports = {
  buildRequestParts,
  generateImage,
  fetchKieTaskRecordOnce,
  downloadResult,
  resultImageUrlFromRecordData,
  KiePollTimeoutError,
  id: 'kie_nano_banana_pro',
  label: 'Kie.ai — Nano Banana Pro',
  vendor: 'kie_ai'
};
