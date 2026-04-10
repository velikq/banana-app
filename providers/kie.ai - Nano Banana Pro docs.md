# Google - Nano Banana Pro

## OpenAPI Specification

```yaml
openapi: 3.0.1
info:
  title: ''
  description: ''
  version: 1.0.0
paths:
  /api/v1/jobs/createTask:
    post:
      summary: Google - Nano Banana Pro
      deprecated: false
      description: >
        Image generation using Google's Pro Image to Image model


        ## Query Task Status


        After submitting a task, use the unified query endpoint to check
        progress and retrieve results:


        <Card title="Get Task Details" icon="lucide-search"
        href="/market/common/get-task-detail">
          Learn how to query task status and retrieve generation results
        </Card>


        ::: tip[]

        For production use, we recommend using the `callBackUrl` parameter to
        receive automatic notifications when generation completes, rather than
        polling the status endpoint.

        :::


        ## Related Resources


        <CardGroup cols={2}>
          <Card title="Market Overview" icon="lucide-store" href="/market/quickstart">
            Explore all available models
          </Card>
          <Card title="Common API" icon="lucide-cog" href="/common-api/get-account-credits">
            Check credits and account usage
          </Card>
        </CardGroup>
      operationId: nano-banana-pro
      tags:
        - docs/en/Market/Image    Models/Google
      parameters: []
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required:
                - model
              properties:
                model:
                  type: string
                  enum:
                    - nano-banana-pro
                  default: nano-banana-pro
                  description: |-
                    The model name to use for generation. Required field.

                    - Must be `nano-banana-pro` for this endpoint
                  examples:
                    - nano-banana-pro
                callBackUrl:
                  type: string
                  format: uri
                  description: >-
                    The URL to receive generation task completion updates.
                    Optional but recommended for production use.


                    - System will POST task status and results to this URL when
                    generation completes

                    - Callback includes generated content URLs and task
                    information

                    - Your callback endpoint should accept POST requests with
                    JSON payload containing results

                    - Alternatively, use the Get Task Details endpoint to poll
                    task status

                    - To ensure callback security, see [Webhook Verification
                    Guide](/common-api/webhook-verification) for signature
                    verification implementation
                  examples:
                    - https://your-domain.com/api/callback
                input:
                  type: object
                  description: Input parameters for the generation task
                  properties:
                    prompt:
                      description: >-
                        A text description of the image you want to generate
                        (Max length: 10000 characters)
                      type: string
                      maxLength: 10000
                      examples:
                        - >-
                          Comic poster: cool banana hero in shades leaps from
                          sci-fi pad. Six panels: 1) 4K mountain landscape, 2)
                          banana holds page of long multilingual text with auto
                          translation, 3) Gemini 3 hologram for
                          search/knowledge/reasoning, 4) camera UI sliders for
                          angle focus color, 5) frame trio 1:1-9:16, 6)
                          consistent banana poses. Footer shows Google icons.
                          Tagline: Nano Banana Pro now on Kie AI.
                    image_input:
                      description: >-
                        Input images to transform or use as reference (supports
                        up to 8 images) (File URL after upload, not file
                        content; Accepted types: image/jpeg, image/png,
                        image/webp; Max size: 30.0MB)
                      type: array
                      items:
                        type: string
                        format: uri
                      maxItems: 8
                      examples:
                        - []
                    aspect_ratio:
                      description: Aspect ratio of the generated image
                      type: string
                      enum:
                        - '1:1'
                        - '2:3'
                        - '3:2'
                        - '3:4'
                        - '4:3'
                        - '4:5'
                        - '5:4'
                        - '9:16'
                        - '16:9'
                        - '21:9'
                        - auto
                      default: '1:1'
                      examples:
                        - '1:1'
                    resolution:
                      description: Resolution of the generated image
                      type: string
                      enum:
                        - 1K
                        - 2K
                        - 4K
                      default: 1K
                      examples:
                        - 1K
                    output_format:
                      description: Format of the output image
                      type: string
                      enum:
                        - png
                        - jpg
                      default: png
                      examples:
                        - png
                  required:
                    - prompt
                  x-apidog-orders:
                    - prompt
                    - image_input
                    - aspect_ratio
                    - resolution
                    - output_format
                  x-apidog-ignore-properties: []
              x-apidog-orders:
                - model
                - callBackUrl
                - input
              x-apidog-ignore-properties: []
            example:
              model: nano-banana-pro
              callBackUrl: https://your-domain.com/api/callback
              input:
                prompt: >-
                  Comic poster: cool banana hero in shades leaps from sci-fi
                  pad. Six panels: 1) 4K mountain landscape, 2) banana holds
                  page of long multilingual text with auto translation, 3)
                  Gemini 3 hologram for search/knowledge/reasoning, 4) camera UI
                  sliders for angle focus color, 5) frame trio 1:1-9:16, 6)
                  consistent banana poses. Footer shows Google icons. Tagline:
                  Nano Banana Pro now on Kie AI.
                image_input: []
                aspect_ratio: '1:1'
                resolution: 1K
                output_format: png
      responses:
        '200':
          description: Request successful
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/ApiResponse'
              example:
                code: 200
                msg: success
                data:
                  taskId: task_nano-banana-pro_1765178625768
          headers: {}
          x-apidog-name: ''
        '500':
          description: request failed
          content:
            application/json:
              schema:
                type: object
                properties:
                  code:
                    type: integer
                    description: >-
                      Response status code


                      - **200**: Success - Request has been processed
                      successfully

                      - **401**: Unauthorized - Authentication credentials are
                      missing or invalid

                      - **402**: Insufficient Credits - Account does not have
                      enough credits to perform the operation

                      - **404**: Not Found - The requested resource or endpoint
                      does not exist

                      - **422**: Validation Error - The request parameters
                      failed validation checks

                      - **429**: Rate Limited - Request limit has been exceeded
                      for this resource

                      - **455**: Service Unavailable - System is currently
                      undergoing maintenance

                      - **500**: Server Error - An unexpected error occurred
                      while processing the request

                      - **501**: Generation Failed - Content generation task
                      failed

                      - **505**: Feature Disabled - The requested feature is
                      currently disabled
                  msg:
                    type: string
                    description: Response message, error description when failed
                  data:
                    type: object
                    properties: {}
                    x-apidog-orders: []
                    x-apidog-ignore-properties: []
                x-apidog-orders:
                  - code
                  - msg
                  - data
                required:
                  - code
                  - msg
                  - data
                x-apidog-ignore-properties: []
              example:
                code: 500
                msg: >-
                  Server Error - An unexpected error occurred while processing
                  the request
                data: null
          headers: {}
          x-apidog-name: 'Error '
      security:
        - BearerAuth: []
          x-apidog:
            schemeGroups:
              - id: kn8M4YUlc5i0A0179ezwx
                schemeIds:
                  - BearerAuth
            required: true
            use:
              id: kn8M4YUlc5i0A0179ezwx
            scopes:
              kn8M4YUlc5i0A0179ezwx:
                BearerAuth: []
      x-apidog-folder: docs/en/Market/Image    Models/Google
      x-apidog-status: released
      x-run-in-apidog: https://app.apidog.com/web/project/1184766/apis/api-28506363-run
components:
  schemas:
    ApiResponse:
      type: object
      properties:
        code:
          type: integer
          enum:
            - 200
            - 401
            - 402
            - 404
            - 422
            - 429
            - 455
            - 500
            - 501
            - 505
          description: >-
            Response status code


            - **200**: Success - Request has been processed successfully

            - **401**: Unauthorized - Authentication credentials are missing or
            invalid

            - **402**: Insufficient Credits - Account does not have enough
            credits to perform the operation

            - **404**: Not Found - The requested resource or endpoint does not
            exist

            - **422**: Validation Error - The request parameters failed
            validation checks

            - **429**: Rate Limited - Request limit has been exceeded for this
            resource

            - **455**: Service Unavailable - System is currently undergoing
            maintenance

            - **500**: Server Error - An unexpected error occurred while
            processing the request

            - **501**: Generation Failed - Content generation task failed

            - **505**: Feature Disabled - The requested feature is currently
            disabled
        msg:
          type: string
          description: Response message, error description when failed
          examples:
            - success
        data:
          type: object
          properties:
            taskId:
              type: string
              description: >-
                Task ID, can be used with Get Task Details endpoint to query
                task status
          x-apidog-orders:
            - taskId
          required:
            - taskId
          x-apidog-ignore-properties: []
      x-apidog-orders:
        - code
        - msg
        - data
      title: response not with recordId
      required:
        - data
      x-apidog-ignore-properties: []
      x-apidog-folder: ''
  securitySchemes:
    BearerAuth:
      type: bearer
      scheme: bearer
      bearerFormat: API Key
      description: |-
        所有 API 都需要通过 Bearer Token 进行身份验证。

        获取 API Key：
        1. 访问 [API Key 管理页面](https://kie.ai/api-key) 获取您的 API Key

        使用方法：
        在请求头中添加：
        Authorization: Bearer YOUR_API_KEY

        注意事项：
        - 请妥善保管您的 API Key，切勿泄露给他人
        - 若怀疑 API Key 泄露，请立即在管理页面重置
servers:
  - url: https://api.kie.ai
    description: 正式环境
security:
  - BearerAuth: []
    x-apidog:
      schemeGroups:
        - id: kn8M4YUlc5i0A0179ezwx
          schemeIds:
            - BearerAuth
      required: true
      use:
        id: kn8M4YUlc5i0A0179ezwx
      scopes:
        kn8M4YUlc5i0A0179ezwx:
          BearerAuth: []

```
