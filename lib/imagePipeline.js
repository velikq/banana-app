const fs = require('fs').promises;
const path = require('path');
const { injectPngMetadata } = require('./pngMetadata');

/**
 * Convert to PNG when possible, inject BananaApp metadata, write under outputDir.
 * @param {object} opts
 * @param {import('electron').NativeImage} opts.nativeImage
 * @param {typeof import('piexifjs')} opts.piexif
 * @param {Buffer} opts.buffer
 * @param {string} opts.mimeType
 * @param {{ prompt: string, resolution: string, ratio: string, referenceImages: Array<{ hash: string, mimeType: string }> }} opts.metaData
 * @param {string} opts.outputDir
 * @param {{ log?: Function, error?: Function }} [opts.logger]
 * @returns {Promise<string>} absolute file path
 */
async function finalizeAndSaveImage(opts) {
  const { nativeImage, piexif, buffer: initialBuffer, mimeType: initialMime, metaData, outputDir, logger = {} } = opts;

  let finalBuffer = initialBuffer;
  let finalMime = initialMime;

  if (finalMime !== 'image/png') {
    logger.log?.(`Converting ${finalMime} to image/png...`);
    try {
      const img = nativeImage.createFromBuffer(finalBuffer);
      finalBuffer = img.toPNG();
      finalMime = 'image/png';
    } catch (convErr) {
      logger.error?.('Conversion to PNG failed:', convErr);
    }
  }

  const metaString = JSON.stringify(metaData);
  const safeMetaString = Buffer.from(metaString).toString('base64');

  let savedBuffer = finalBuffer;

  try {
    if (finalMime === 'image/png') {
      logger.log?.('Injecting PNG metadata...');
      savedBuffer = injectPngMetadata(finalBuffer, 'BananaAppMeta', safeMetaString);
    } else if (finalMime === 'image/jpeg') {
      logger.log?.('Injecting JPEG metadata (fallback)...');
      const exifObj = {
        Exif: {
          [piexif.ExifIFD.UserComment]: 'BananaAppMeta:' + safeMetaString
        }
      };
      const exifBytes = piexif.dump(exifObj);
      const newData = piexif.insert(exifBytes, finalBuffer.toString('binary'));
      savedBuffer = Buffer.from(newData, 'binary');
    }
  } catch (metaErr) {
    logger.error?.('Metadata injection failed, saving raw image:', metaErr);
    savedBuffer = finalBuffer;
  }

  const fileName = `banana_${Date.now()}.png`;
  logger.log?.(`Saving to: ${outputDir}`);

  await fs.mkdir(outputDir, { recursive: true });
  const fullPath = path.join(outputDir, fileName);
  await fs.writeFile(fullPath, savedBuffer);
  logger.log?.(`File written: ${fullPath}`);

  return fullPath;
}

module.exports = { finalizeAndSaveImage };
