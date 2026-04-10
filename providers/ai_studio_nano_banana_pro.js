const { GoogleGenAI } = require('@google/genai');
const { buildGeminiContents } = require('../lib/referenceParts');

const MODEL = 'gemini-3-pro-image-preview';

function buildRequestParts(prompt, inputDir, referenceImages, options) {
  return buildGeminiContents(prompt, inputDir, referenceImages, options);
}

/**
 * @param {object} ctx
 * @param {string} ctx.apiKey
 * @param {string} ctx.resolution
 * @param {string} ctx.ratio
 * @param {Array} ctx.parts - Gemini contents (flat parts array)
 * @param {{ log?: Function, error?: Function }} [ctx.logger]
 * @param {(label: string, data: unknown) => void} [ctx.sendDebug]
 * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
 */
async function generateImage(ctx) {
  const { apiKey, resolution, ratio, parts, logger = {}, sendDebug } = ctx;

  if (!apiKey) {
    throw new Error('API Key is missing in .env file');
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: 600000 }
  });

  const config = {
    responseModalities: ['IMAGE'],
    imageConfig: {
      imageSize: resolution,
      aspectRatio: ratio
    }
  };

  if (sendDebug) {
    sendDebug('Contents being sent to AI Studio (Nano Banana Pro):', JSON.stringify(parts, null, 2));
  }

  logger.log?.('Sending request to Google AI Studio...');

  const responseStream = await ai.models.generateContentStream({
    model: MODEL,
    config,
    contents: parts
  });

  let finalBuffer = null;
  let finalMime = 'image/png';
  let collectedText = '';

  logger.log?.('Reading stream...');

  for await (const chunk of responseStream) {
    const cand = chunk.candidates?.[0];
    if (cand?.content?.parts) {
      for (const part of cand.content.parts) {
        if (part.inlineData) {
          logger.log?.('Received image chunk.');
          const inlineData = part.inlineData;
          finalMime = inlineData.mimeType || 'image/png';
          finalBuffer = Buffer.from(inlineData.data || '', 'base64');
        }
        if (part.text) {
          collectedText += part.text;
        }
      }
    }
    if (finalBuffer) break;
  }

  if (!finalBuffer) {
    if (collectedText) {
      logger.error?.('API returned text instead of image:', collectedText);
      if (sendDebug) sendDebug('API Response Text:', collectedText);
    }
    logger.error?.('No buffer received.');
    throw new Error('No image data received from API.');
  }

  logger.log?.(`Image received. Size: ${finalBuffer.length}, Mime: ${finalMime}`);

  return { buffer: finalBuffer, mimeType: finalMime };
}

module.exports = {
  buildRequestParts,
  generateImage,
  id: 'ai_studio_nano_banana_pro',
  label: 'AI Studio — Nano Banana Pro (gemini-3-pro-image-preview)',
  vendor: 'ai_studio'
};
