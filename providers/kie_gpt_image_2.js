const { createKieImageProvider } = require('./kie_nano_banana_pro');

module.exports = createKieImageProvider({
  id: 'kie_gpt_image_2',
  label: 'Kie.ai — GPT Image 2',
  textModel: 'gpt-image-2-text-to-image',
  editModel: 'gpt-image-2-image-to-image',
  capabilities: {
    resolutions: ['1K', '2K', '4K'],
    qualities: [],
    ratios: ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '3:1', '1:3', '21:9', '9:21'],
    resolutionRules: {
      text: { auto: ['1K'], '1:1': ['1K', '2K'], '5:4': ['1K'], '4:5': ['1K'], '3:1': ['1K'], '1:3': ['1K'], '9:21': ['1K'] },
      edit: { auto: ['1K'], '1:1': ['1K', '2K'], '5:4': ['1K'], '4:5': ['1K'] }
    }
  },
  normalizeOptions({ ratio, resolution, isEdit }) {
    const capabilities = this.capabilities;
    const safeRatio = capabilities.ratios.includes(ratio) ? ratio : 'auto';
    const allowed = (capabilities.resolutionRules[isEdit ? 'edit' : 'text'][safeRatio] || capabilities.resolutions);
    return {
      ratio: safeRatio,
      resolution: allowed.includes(resolution) ? resolution : allowed[0],
      quality: null
    };
  },
  buildInput({ prompt, imageUrls, isEdit, ratio, resolution }) {
    const input = { prompt, aspect_ratio: ratio, resolution };
    if (isEdit) input.input_urls = imageUrls;
    return input;
  }
});
