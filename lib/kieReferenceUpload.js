const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mime = require('mime').default;

const KIE_UPLOAD_BASE = 'https://kieai.redpandaai.co';
/** Use JSON base64 upload for files up to this size; larger files use multipart (buffer body, not streams). */
const PREFER_BASE64_MAX_BYTES = 4 * 1024 * 1024;
const MULTIPART_UPLOAD_ATTEMPTS = 3;
const MULTIPART_RETRY_DELAY_MS = 900;
const DEFAULT_TTL_MS = Math.floor(2.5 * 24 * 60 * 60 * 1000);

const inFlight = new Map();

/** Serialize Kie reference uploads across concurrent generate jobs (cache workaround). */
let kieUploadTail = Promise.resolve();

function runKieUploadSerialized(fn) {
  const next = kieUploadTail.then(() => fn());
  kieUploadTail = next.then(
    () => {},
    () => {}
  );
  return next;
}

function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, 16);
}

function expiresMsFromUploadData(data) {
  if (data && data.expiresAt) {
    const t = Date.parse(data.expiresAt);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now() + DEFAULT_TTL_MS;
}

function parseUploadJson(json, resStatus) {
  const ok = (json.success === true || json.code === 200) && json.data;
  if (!ok) {
    const msg = json.msg || json.message || '';
    const code = json.code != null ? ` [code ${json.code}]` : '';
    throw new Error(msg ? `${msg}${code}` : `Kie file upload failed (HTTP ${resStatus})${code}`);
  }
  const url = json.data.fileUrl || json.data.downloadUrl;
  if (!url) throw new Error('Kie upload: no file URL in response');
  return { url, expiresAtMs: expiresMsFromUploadData(json.data) };
}

function parseResponseBodyText(text, res) {
  const trimmed = (text || '').trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`Kie upload: expected JSON, got HTTP ${res.status}: ${trimmed.slice(0, 160)}`);
  }
}

function isTransientUploadError(err) {
  const m = String(err && err.message ? err.message : err);
  return /internal server error|502|503|504|timeout|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|temporar/i.test(
    m
  );
}

async function uploadBase64(apiKey, filePath, mimeType, fileName) {
  const buf = fs.readFileSync(filePath);
  const b64 = buf.toString('base64');
  const dataUrl = `data:${mimeType};base64,${b64}`;
  const res = await fetch(`${KIE_UPLOAD_BASE}/api/file-base64-upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      base64Data: dataUrl,
      uploadPath: 'banana-app',
      fileName: fileName || path.basename(filePath)
    })
  });
  const json = parseResponseBodyText(await res.text(), res);
  if (!res.ok) {
    throw new Error(json.msg || json.message || `Kie base64 upload HTTP ${res.status}`);
  }
  return parseUploadJson(json, res.status);
}

/**
 * Multipart to Kie `file-stream-upload` using global FormData + Blob (no `form-data` stream / duplex).
 */
async function uploadMultipartOnce(apiKey, filePath, mimeType, fileName) {
  const fname = fileName || path.basename(filePath);
  const buf = fs.readFileSync(filePath);
  const blob = new Blob([buf], { type: mimeType || 'application/octet-stream' });
  const form = new FormData();
  form.append('file', blob, fname);
  form.append('uploadPath', 'banana-app');
  form.append('fileName', fname);

  const res = await fetch(`${KIE_UPLOAD_BASE}/api/file-stream-upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });
  const json = parseResponseBodyText(await res.text(), res);
  if (!res.ok) {
    throw new Error(json.msg || json.message || `Kie multipart upload HTTP ${res.status}`);
  }
  return parseUploadJson(json, res.status);
}

async function uploadMultipartWithRetries(apiKey, filePath, mimeType, fileName, logger) {
  let lastErr;
  for (let attempt = 1; attempt <= MULTIPART_UPLOAD_ATTEMPTS; attempt++) {
    try {
      return await uploadMultipartOnce(apiKey, filePath, mimeType, fileName);
    } catch (e) {
      lastErr = e;
      const retry = attempt < MULTIPART_UPLOAD_ATTEMPTS && isTransientUploadError(e);
      if (!retry) throw e;
      logger.warn?.(`Kie multipart upload attempt ${attempt}/${MULTIPART_UPLOAD_ATTEMPTS} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, MULTIPART_RETRY_DELAY_MS * attempt));
    }
  }
  throw lastErr;
}

async function uploadOneFile(apiKey, filePath, mimeType, fileName, logger) {
  const stat = fs.statSync(filePath);
  if (stat.size <= PREFER_BASE64_MAX_BYTES) {
    logger.log?.(`Kie upload: base64 (${stat.size} B) ${fileName}`);
    return uploadBase64(apiKey, filePath, mimeType, fileName);
  }
  logger.log?.(`Kie upload: multipart (${stat.size} B) ${fileName}`);
  return uploadMultipartWithRetries(apiKey, filePath, mimeType, fileName, logger);
}

/**
 * Upload reference images to Kie and return public URLs (order matches successful uploads only).
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.vendor - e.g. kie_ai (cache namespace)
 * @param {string} opts.inputDir
 * @param {Array<{ hash: string, mimeType: string, extension?: string }>} opts.referenceImages
 * @param {{ log?: Function, warn?: Function }} [opts.logger]
 * @param {import('./kieUploadCacheSqlite').KieUploadCacheSqlite | null} [opts.cacheStore]
 * @param {(msg: string) => void} [opts.sendRequestLog] — UI request log (renderer)
 * @returns {Promise<string[]>}
 */
async function uploadReferenceImagesCore(opts) {
  const { apiKey, vendor, inputDir, referenceImages, logger = {}, cacheStore, sendRequestLog } = opts;
  const apiKeyHash = hashApiKey(apiKey);

  if (cacheStore) cacheStore.pruneExpired();

  const urls = [];
  const refs = (referenceImages || []).slice(0, 8);

  for (const ref of refs) {
    const ext = ref.extension || mime.getExtension(ref.mimeType);
    const fileName = `${ref.hash}.${ext}`;
    const filePath = path.join(inputDir, fileName);

    if (!fs.existsSync(filePath)) {
      logger.warn?.(`Kie: reference not found: ${filePath}`);
      continue;
    }

    const contentHash = ref.hash;
    const inFlightKey = `${vendor}\0${apiKeyHash}\0${contentHash}`;

    let pending = inFlight.get(inFlightKey);
    if (!pending) {
      pending = (async () => {
        if (cacheStore) {
          const row = cacheStore.get(vendor, apiKeyHash, contentHash);
          if (row) {
            logger.log?.(`Kie upload cache hit: ${contentHash}`);
            sendRequestLog?.(`Kie image upload start: ${fileName}`);
            sendRequestLog?.(`Kie image upload end: ${fileName} (cached)`);
            return { url: row.url, expiresAtMs: row.expires_at_ms };
          }
        }

        sendRequestLog?.(`Kie image upload start: ${fileName}`);
        try {
          const { url, expiresAtMs } = await uploadOneFile(
            apiKey,
            filePath,
            ref.mimeType,
            fileName,
            logger
          );
          sendRequestLog?.(`Kie image upload end: ${fileName}`);
          if (cacheStore) {
            cacheStore.set(vendor, apiKeyHash, contentHash, url, expiresAtMs);
          }
          return { url, expiresAtMs };
        } catch (e) {
          sendRequestLog?.(`Kie image upload failed: ${fileName} — ${e.message}`);
          throw e;
        }
      })();

      inFlight.set(inFlightKey, pending);
      pending.finally(() => {
        inFlight.delete(inFlightKey);
      });
    }

    const { url } = await pending;
    urls.push(url);
  }

  return urls;
}

async function uploadReferenceImages(opts) {
  return runKieUploadSerialized(() => uploadReferenceImagesCore(opts));
}

module.exports = {
  uploadReferenceImages,
  hashApiKey,
  PREFER_BASE64_MAX_BYTES,
  KIE_UPLOAD_BASE
};
