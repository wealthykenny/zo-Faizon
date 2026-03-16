import { neon } from '@neondatabase/serverless';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

const MODE_PRESETS = {
  realistic: {
    displayModel: 'Faizon Realistic',
    routingModel: 'gemini-3.1-pro-preview',
    fallbackModel: 'gemini-3-flash-preview',
    imageModel: 'gemini-3.1-flash-image-preview',
    systemPrompt: `You are the cinematic prompt brain for Faizon Realistic.
Your job is to convert user intent into ultra-detailed, photorealistic production prompts for text-to-image or image editing.
Always optimize for realism, anatomy, believable lighting, high-end camera language, material accuracy, lens behavior, environmental coherence, and detailed facial rendering.
Never make the output cartoony unless the user explicitly asks.
Return strict JSON with keys: productionPrompt, safetyNotes.`
  },
  aesthetics: {
    displayModel: 'Faizon Aesthetics',
    routingModel: 'gemini-3.1-pro-preview',
    fallbackModel: 'gemini-3-flash-preview',
    imageModel: 'gemini-3.1-flash-image-preview',
    systemPrompt: `You are the aesthetic direction engine for Faizon Aesthetics.
Transform user intent into highly visual, emotionally charged production prompts with strong artistic identity.
You specialize in: iPhone 4S snapshots, 80s flash, radial blur, dual-tone, surrealism, cottagecore, analog imperfections, dreamy color cast, editorial framing, liminal atmosphere, youth nostalgia, and experimental fashion imagery.
Preserve clear subject readability while making the style feel intentional and premium.
Return strict JSON with keys: productionPrompt, safetyNotes.`
  }
};

let keyRotationIndex = 0;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body)
  };
}

function getGeminiKeys() {
  const keys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
    process.env.GEMINI_API_KEY
  ].filter(Boolean);

  if (!keys.length) {
    throw new Error('No Gemini API keys found. Add GEMINI_API_KEY_1 to GEMINI_API_KEY_5 in Netlify environment variables.');
  }

  return keys;
}

function getOrderedKeys() {
  const keys = getGeminiKeys();
  const start = keyRotationIndex % keys.length;
  keyRotationIndex = (keyRotationIndex + 1) % keys.length;
  return [...keys.slice(start), ...keys.slice(0, start)];
}

function isRetryableGeminiError(message = '') {
  const text = String(message).toLowerCase();
  return (
    text.includes('quota') ||
    text.includes('rate limit') ||
    text.includes('rate_limit') ||
    text.includes('resource exhausted') ||
    text.includes('temporarily unavailable') ||
    text.includes('deadline exceeded') ||
    text.includes('internal error') ||
    text.includes('backend error') ||
    text.includes('503') ||
    text.includes('429')
  );
}

async function withGeminiKeyRotation(fn) {
  const orderedKeys = getOrderedKeys();
  let lastError;

  for (let i = 0; i < orderedKeys.length; i += 1) {
    const apiKey = orderedKeys[i];

    try {
      return await fn(apiKey);
    } catch (error) {
      lastError = error;
      const isLast = i === orderedKeys.length - 1;
      if (!isRetryableGeminiError(error.message) && !isLast) {
        throw error;
      }
      if (!isLast) continue;
    }
  }

  throw lastError || new Error('All Gemini keys failed.');
}

async function callGeminiJSON({ model, contents, systemInstruction }) {
  return withGeminiKeyRotation(async (apiKey) => {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          contents,
          generationConfig: {
            responseMimeType: 'application/json'
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error?.message || `Gemini JSON request failed for ${model}`);
    }

    const text =
      data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '{}';

    return JSON.parse(text);
  });
}

async function callGeminiImage({ model, textPrompt, aspectRatio, editImage }) {
  return withGeminiKeyRotation(async (apiKey) => {
    const parts = [{ text: textPrompt }];

    if (editImage?.data && editImage?.mimeType) {
      parts.push({
        inlineData: {
          data: editImage.data,
          mimeType: editImage.mimeType
        }
      });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {
              aspectRatio
            }
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error?.message || `Gemini image request failed for ${model}`);
    }

    const candidateParts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = candidateParts.find((part) => part.inlineData?.data);
    const textPart = candidateParts.find((part) => part.text);

    if (!imagePart?.inlineData?.data) {
      throw new Error(textPart?.text || 'No image returned by Gemini');
    }

    return {
      image: `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`,
      mimeType: imagePart.inlineData.mimeType,
      modelText: textPart?.text || ''
    };
  });
}

function getS3Client() {
  if (
    !process.env.S3_ACCESS_KEY_ID ||
    !process.env.S3_SECRET_ACCESS_KEY ||
    !process.env.S3_REGION ||
    !process.env.S3_BUCKET_NAME
  ) {
    return null;
  }

  return new S3Client({
    region: process.env.S3_REGION,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
    }
  });
}

function buildPublicS3Url(key) {
  const publicBase = process.env.S3_PUBLIC_URL?.replace(/\/$/, '');
  if (publicBase) return `${publicBase}/${key}`;
  return `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.S3_REGION}.amazonaws.com/${key}`;
}

async function uploadImageToS3(dataUrl, mode) {
  const s3 = getS3Client();
  if (!s3) return null;

  const matches = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!matches) return null;

  const mimeType = matches[1];
  const base64Data = matches[2];
  const buffer = Buffer.from(base64Data, 'base64');
  const extension = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
  const key = `generated/${mode}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${extension}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      Tagging: 'autodelete=true&ttl=2days'
    })
  );

  return buildPublicS3Url(key);
}

async function logGeneration(record) {
  if (!process.env.DATABASE_URL) return;

  const sql = neon(process.env.DATABASE_URL);

  await sql`CREATE TABLE IF NOT EXISTS fazion_generations (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    mode TEXT NOT NULL,
    prompt TEXT NOT NULL,
    production_prompt TEXT NOT NULL,
    aspect_ratio TEXT NOT NULL,
    image_model TEXT NOT NULL,
    image_url TEXT
  )`;

  await sql`
    INSERT INTO fazion_generations (mode, prompt, production_prompt, aspect_ratio, image_model, image_url)
    VALUES (${record.mode}, ${record.prompt}, ${record.productionPrompt}, ${record.aspectRatio}, ${record.imageModel}, ${record.imageUrl})
  `;
}

export default async (req) => {
  if (req.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS };
  }

  if (req.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  try {
    const { mode = 'realistic', prompt = '', negativePrompt = '', aspectRatio = '1:1', editImage = null } =
      JSON.parse(req.body || '{}');

    if (!MODE_PRESETS[mode]) {
      return json(400, { error: 'Invalid mode' });
    }

    if (!prompt.trim()) {
      return json(400, { error: 'Prompt is required' });
    }

    const preset = MODE_PRESETS[mode];

    const routingPayload = {
      userPrompt: prompt.trim(),
      negativePrompt: negativePrompt.trim(),
      aspectRatio,
      operation: editImage ? 'photorealistic image edit' : 'text to image generation'
    };

    let refined;
    try {
      refined = await callGeminiJSON({
        model: preset.routingModel,
        systemInstruction: preset.systemPrompt,
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(routingPayload) }] }]
      });
    } catch (error) {
      refined = await callGeminiJSON({
        model: preset.fallbackModel,
        systemInstruction: preset.systemPrompt,
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(routingPayload) }] }]
      });
    }

    const productionPrompt = [
      refined.productionPrompt,
      negativePrompt.trim() ? `Avoid: ${negativePrompt.trim()}.` : '',
      editImage
        ? 'Preserve the identity and core composition of the uploaded image unless the user explicitly requests structural changes.'
        : '',
      'Output must be polished, premium, visually coherent, and production-ready.'
    ]
      .filter(Boolean)
      .join('\n\n');

    const generated = await callGeminiImage({
      model: preset.imageModel,
      textPrompt: productionPrompt,
      aspectRatio,
      editImage
    });

    const s3Url = await uploadImageToS3(generated.image, mode);

    await logGeneration({
      mode,
      prompt,
      productionPrompt,
      aspectRatio,
      imageModel: preset.imageModel,
      imageUrl: s3Url
    });

    return json(200, {
      ok: true,
      displayModel: preset.displayModel,
      routingModel: preset.routingModel,
      imageModel: preset.imageModel,
      aspectRatio,
      productionPrompt,
      image: generated.image,
      imageUrl: s3Url,
      imageModelNotes: generated.modelText
    });
  } catch (error) {
    return json(500, { error: error.message || 'Unknown server error' });
  }
};
