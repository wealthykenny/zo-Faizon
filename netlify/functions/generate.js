import crypto from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { neon } from '@neondatabase/serverless';

const MODE_PRESETS = {
  realistic: {
    displayModel: 'Faizon Realistic',
    routingModel: 'gemini-2.5-pro',
    fallbackModel: 'gemini-2.5-flash',
    imageModel: 'gemini-2.5-flash-image-preview',
    systemPrompt: `You are the cinematic prompt brain for Faizon Realistic.
Convert user requests into highly detailed photorealistic prompts for premium text-to-image and photorealistic image editing.
Prioritize realism, skin texture, true-to-life lighting, lens realism, material accuracy, facial detail, and environmental coherence.
Return strict JSON with keys: productionPrompt, safetyNotes.`
  },
  aesthetics: {
    displayModel: 'Faizon Aesthetics',
    routingModel: 'gemini-2.5-pro',
    fallbackModel: 'gemini-2.5-flash',
    imageModel: 'gemini-2.5-flash-image-preview',
    systemPrompt: `You are the aesthetic direction engine for Faizon Aesthetics.
Convert user requests into rich artistic prompts with visual styles like iPhone 4S, 80s photography, radial blur, dual-tone, surreal aesthetics, cottagecore, analog mood, dreamy editorial framing, and nostalgic texture.
Return strict JSON with keys: productionPrompt, safetyNotes.`
  }
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

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

  if (!keys.length) throw new Error('No Gemini API keys found in Netlify environment variables.');
  return keys;
}

function keyOrder(keys, seedText = '') {
  const seed = crypto.createHash('sha1').update(seedText).digest().readUInt32BE(0);
  const start = seed % keys.length;
  return keys.map((_, index) => keys[(start + index) % keys.length]);
}

function shouldRetry(errorMessage) {
  const text = String(errorMessage || '').toLowerCase();
  return ['quota', 'rate', '429', '503', 'overloaded', 'temporar', 'unavailable'].some((part) => text.includes(part));
}

async function geminiRequest({ model, apiKey, body }) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `Gemini request failed for ${model}`);
  return data;
}

async function withKeyRotation(seed, worker) {
  const keys = keyOrder(getGeminiKeys(), seed);
  let lastError = null;

  for (const key of keys) {
    try {
      return await worker(key);
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error?.message)) throw error;
    }
  }

  throw lastError || new Error('All Gemini keys failed.');
}

async function callGeminiJSON({ model, systemInstruction, payload, seed }) {
  return withKeyRotation(seed, async (apiKey) => {
    const data = await geminiRequest({
      model,
      apiKey,
      body: {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(payload) }] }],
        generationConfig: { responseMimeType: 'application/json' }
      }
    });

    const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '{}';
    return JSON.parse(text);
  });
}

async function callGeminiImage({ model, prompt, aspectRatio, editImage, seed }) {
  return withKeyRotation(seed, async (apiKey) => {
    const parts = [{ text: prompt }];
    if (editImage?.data && editImage?.mimeType) {
      parts.push({ inlineData: { data: editImage.data, mimeType: editImage.mimeType } });
    }

    const data = await geminiRequest({
      model,
      apiKey,
      body: {
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio }
        }
      }
    });

    const candidateParts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = candidateParts.find((part) => part.inlineData?.data);
    const textPart = candidateParts.find((part) => part.text);

    if (!imagePart?.inlineData?.data) throw new Error(textPart?.text || 'No image returned by Gemini.');

    return {
      image: `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`,
      base64: imagePart.inlineData.data,
      mimeType: imagePart.inlineData.mimeType,
      modelText: textPart?.text || ''
    };
  });
}

function getS3Client() {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.AWS_REGION || !process.env.S3_BUCKET_NAME) {
    return null;
  }

  return new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });
}

async function uploadToS3({ buffer, mimeType, mode }) {
  const s3 = getS3Client();
  if (!s3) return null;

  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const key = `generated/${mode}/${Date.now()}-${crypto.randomUUID()}.${ext}`;

  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
    CacheControl: 'public, max-age=31536000, immutable',
    Tagging: 'autodelete=true&ttl=2days'
  }));

  const publicBase = process.env.AWS_S3_PUBLIC_URL?.replace(/\/$/, '');
  if (publicBase) return `${publicBase}/${key}`;
  return `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
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

export default async (request) => {
  if (request.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS };
  if (request.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  try {
    const { mode = 'realistic', prompt = '', negativePrompt = '', aspectRatio = '1:1', editImage = null } = JSON.parse(request.body || '{}');
    if (!MODE_PRESETS[mode]) return json(400, { error: 'Invalid mode.' });
    if (!prompt.trim()) return json(400, { error: 'Prompt is required.' });

    const preset = MODE_PRESETS[mode];
    const seed = `${mode}:${prompt}:${aspectRatio}`;
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
        payload: routingPayload,
        seed
      });
    } catch {
      refined = await callGeminiJSON({
        model: preset.fallbackModel,
        systemInstruction: preset.systemPrompt,
        payload: routingPayload,
        seed: `${seed}:fallback`
      });
    }

    const productionPrompt = [
      refined.productionPrompt,
      negativePrompt.trim() ? `Avoid: ${negativePrompt.trim()}.` : '',
      editImage ? 'Preserve identity and core composition unless the user explicitly requests structural changes.' : '',
      'Output must feel premium, visually coherent, and production ready.'
    ].filter(Boolean).join('\n\n');

    const generated = await callGeminiImage({
      model: preset.imageModel,
      prompt: productionPrompt,
      aspectRatio,
      editImage,
      seed: `${seed}:image`
    });

    const imageBuffer = Buffer.from(generated.base64, 'base64');
    const imageUrl = await uploadToS3({ buffer: imageBuffer, mimeType: generated.mimeType, mode });

    await logGeneration({
      mode,
      prompt,
      productionPrompt,
      aspectRatio,
      imageModel: preset.imageModel,
      imageUrl
    });

    return json(200, {
      ok: true,
      displayModel: preset.displayModel,
      routingModel: preset.routingModel,
      imageModel: preset.imageModel,
      productionPrompt,
      image: generated.image,
      imageUrl,
      imageModelNotes: generated.modelText
    });
  } catch (error) {
    return json(500, { error: error.message || 'Unknown server error.' });
  }
};
