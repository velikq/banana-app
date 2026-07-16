# Kie image models — local reference

Snapshot: 2026-07-15. This is a compact implementation reference, not a replacement for Kie API documentation.

## Shared task flow

- Create: `POST https://api.kie.ai/api/v1/jobs/createTask` with `Authorization: Bearer <KIE_AI_API_KEY>`.
- Status/results: `GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=<id>`.
- Source images must first be uploaded through Kie's File Upload API; pass the resulting public URLs to the model request.

## Models used by Banana App

### Nano Banana Pro

| Field | Value |
|---|---|
| UI provider | `kie_nano_banana_pro` |
| API model | `nano-banana-pro` |
| Generate/edit switch | Same model; send an empty or populated `image_input` array |
| Input fields | `prompt`, `image_input`, `aspect_ratio`, `resolution`, `output_format` |
| Resolutions | `1K`, `2K`, `4K` |
| Ratios in app | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`, `auto` |

Source: <https://docs.kie.ai/market/google/pro-image-to-image>

### Nano Banana 2

| Field | Value |
|---|---|
| UI provider | `kie_nano_banana_2` |
| API model | `nano-banana-2` |
| Generate/edit switch | Same model; send an empty or populated `image_input` array |
| Input fields | `prompt`, `image_input`, `aspect_ratio`, `resolution`, `output_format` |
| Resolutions | `1K`, `2K`, `4K` |
| Ratios in app | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`, `auto` |

Source: <https://docs.kie.ai/market/google/nanobanana2>

### GPT Image 2

| Field | Text to image | Image edit |
|---|---|---|
| UI provider | `kie_gpt_image_2` | `kie_gpt_image_2` |
| API model | `gpt-image-2-text-to-image` | `gpt-image-2-image-to-image` |
| Reference field | — | `input_urls` (up to 16 URLs) |
| Resolutions | `1K`, `2K`, `4K` | `1K`, `2K`, `4K` |
| Ratios | `auto`, `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `5:4`, `4:5`, `16:9`, `9:16`, `2:1`, `1:2`, `3:1`, `1:3`, `21:9`, `9:21` | Same |

Resolution constraints enforced by the app:

- `auto` supports only `1K`.
- `1:1` does not support `4K`.
- Text-to-image: `5:4`, `4:5`, `3:1`, `1:3`, and `9:21` support only `1K`.
- Image edit: `5:4` and `4:5` support only `1K`.

Sources: <https://docs.kie.ai/market/gpt/gpt-image-2-text-to-image>, <https://docs.kie.ai/market/gpt/gpt-image-2-image-to-image>

### Seedream 5 Pro

| Field | Text to image | Image edit |
|---|---|---|
| UI provider | `kie_seedream_5_pro` | `kie_seedream_5_pro` |
| API model | `seedream/5-pro-text-to-image` | `seedream/5-pro-image-to-image` |
| Reference field | — | `image_urls` (up to 10 URLs) |
| Accepted source image types | — | JPEG, PNG, WebP; maximum 10 MB per file |
| Ratios | `1:1`, `4:3`, `3:4`, `16:9`, `9:16`, `2:3`, `3:2`, `21:9` | Same |
| Quality | `basic` (1K) or `high` (2K) | Same |
| Output format | `png` or `jpeg` | `png` or `jpeg` |

Sources: <https://docs.kie.ai/market/seedream/5-pro-text-to-image>, <https://docs.kie.ai/market/seedream/5-pro-image-to-image>

## Metadata schema used by Banana App

`BananaAppMeta` stores `provider`, `resolution`, `ratio`, `quality`, `prompt`, and reference-image hashes. Context restore switches to the saved provider and normalizes the saved settings to that provider's current capability set.
