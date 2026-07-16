const { createKieImageProvider } = require('./kie_nano_banana_pro');

module.exports = createKieImageProvider({
  id: 'kie_seedream_5_pro',
  label: 'Kie.ai — Seedream 5 Pro',
  textModel: 'seedream/5-pro-text-to-image',
  editModel: 'seedream/5-pro-image-to-image',
  capabilities: {
    resolutions: [],
    qualities: ['basic', 'high'],
    ratios: ['1:1', '4:3', '3:4', '16:9', '9:16', '2:3', '3:2', '21:9']
  },
  normalizeOptions({ ratio, quality }) {
    const safeQuality = quality === 'high' ? 'high' : 'basic';
    return {
      ratio: this.capabilities.ratios.includes(ratio) ? ratio : '1:1',
      resolution: safeQuality === 'high' ? '2K' : '1K',
      quality: safeQuality
    };
  },
  buildInput({ prompt, imageUrls, isEdit, ratio, quality }) {
    const input = {
      prompt,
      aspect_ratio: ratio,
      quality,
      output_format: 'png',
      nsfw_checker: false
    };
    if (isEdit) input.image_urls = imageUrls;
    return input;
  }
});
