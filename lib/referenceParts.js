const fs = require('fs');
const path = require('path');
const mime = require('mime').default;

/**
 * Load reference images from disk as Gemini-style content parts.
 * @param {string} inputDir
 * @param {Array<{ hash: string, mimeType: string, extension?: string }>} referenceImages
 * @param {{ warn?: (msg: string) => void }} [options]
 * @returns {Array<{ inlineData: { mimeType: string, data: string } }>}
 */
function loadReferenceInlineParts(inputDir, referenceImages, options = {}) {
  const warn = options.warn || (() => {});
  const parts = [];

  for (const ref of referenceImages || []) {
    const ext = ref.extension || mime.getExtension(ref.mimeType);
    const filename = `${ref.hash}.${ext}`;
    const filePath = path.join(inputDir, filename);

    if (fs.existsSync(filePath)) {
      const fileData = fs.readFileSync(filePath).toString('base64');
      parts.push({
        inlineData: {
          mimeType: ref.mimeType,
          data: fileData
        }
      });
    } else {
      warn(`Reference image not found: ${filePath}`);
    }
  }

  return parts;
}

/**
 * Full Gemini `contents` array: text prompt + reference inline parts.
 */
function buildGeminiContents(prompt, inputDir, referenceImages, options) {
  const refParts = loadReferenceInlineParts(inputDir, referenceImages, options);
  return [{ text: prompt }, ...refParts];
}

module.exports = {
  loadReferenceInlineParts,
  buildGeminiContents
};
