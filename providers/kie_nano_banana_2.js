const { createKieImageProvider } = require('./kie_nano_banana_pro');

module.exports = createKieImageProvider({
  id: 'kie_nano_banana_2',
  label: 'Kie.ai — Nano Banana 2',
  textModel: 'nano-banana-2',
  editModel: 'nano-banana-2',
  capabilities: {
    resolutions: ['1K', '2K', '4K'],
    qualities: [],
    ratios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', 'auto']
  },
  normalizeOptions({ ratio, resolution }) {
    const ratios = this.capabilities?.ratios || [];
    return {
      ratio: ratios.includes(ratio) ? ratio : '1:1',
      resolution: ['1K', '2K', '4K'].includes(resolution) ? resolution : '1K',
      quality: null
    };
  },
  buildInput({ prompt, imageUrls, ratio, resolution }) {
    return {
      prompt,
      image_input: imageUrls,
      aspect_ratio: ratio,
      resolution,
      output_format: 'png'
    };
  }
});
