import { neon } from '@neondatabase/serverless';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS,GET'
};

const MODE_PRESETS = {
  realistic: {
    displayModel: 'Faizon Realistic',
    routingModel: 'gemini-3.1-pro-preview',
    fallbackModel: 'gemini-3-flash-preview',
    imageModel: 'gemini-3.1-flash-image-preview',
    systemPrompt: `You are the cinematic prompt brain for Faizon Realistic.
Convert requests into ultra-detailed photorealistic prompts.
Return JSON with keys: productionPrompt, safetyNotes.`
  },
  aesthetics: {
    displayModel: 'Faizon Aesthetics',
    routingModel: 'gemini-3.1-pro-preview',
    fallbackModel: 'gemini-3-flash-preview',
    imageModel: 'gemini-3.1-flash-image-preview',
    systemPrompt: `You are the aesthetic direction engine for Faizon Aesthetics.
Generate stylish prompts (iPhone 4S, 80s flash, surreal, cottagecore etc).
Return JSON with keys: productionPrompt, safetyNotes.`
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

/* ---------------- ENV DEBUG ---------------- */

function envCheck() {
  return {
    GEMINI_API_KEY_1: !!process.env.GEMINI_API_KEY_1,
    GEMINI_API_KEY_2: !!process.env.GEMINI_API_KEY_2,
    GEMINI_API_KEY_3: !!process.env.GEMINI_API_KEY_3,
    GEMINI_API_KEY_4: !!process.env.GEMINI_API_KEY_4,
    GEMINI_API_KEY_5: !!process.env.GEMINI_API_KEY_5,
    DATABASE_URL: !!process.env.DATABASE_URL,
    S3_REGION: !!process.env.S3_REGION,
    S3_ACCESS_KEY_ID: !!process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: !!process.env.S3_SECRET_ACCESS_KEY,
    S3_BUCKET_NAME: !!process.env.S3_BUCKET_NAME
  };
}

/* ---------------- GEMINI KEYS ---------------- */

function getGeminiKeys() {
  const keys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5
  ].filter(Boolean);

  if (!keys.length) {
    throw new Error('No Gemini keys found in environment variables.');
  }

  return keys;
}

function getOrderedKeys() {
  const keys = getGeminiKeys();
  const start = keyRotationIndex % keys.length;
  keyRotationIndex = (keyRotationIndex + 1) % keys.length;
  return [...keys.slice(start), ...keys.slice(0, start)];
}

async function withGeminiKeyRotation(fn) {
  const keys = getOrderedKeys();
  let lastError;

  for (const key of keys) {
    try {
      return await fn(key);
    } catch (err) {
      lastError = err;
      console.error('Gemini key failed, rotating', err.message);
    }
  }

  throw lastError || new Error('All Gemini keys failed');
}

/* ---------------- GEMINI CALLS ---------------- */

async function callGeminiJSON({ model, contents, systemInstruction }) {
  return withGeminiKeyRotation(async (apiKey) => {

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents,
          generationConfig: { responseMimeType: 'application/json' }
        })
      }
    );

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.error?.message || 'Gemini JSON request failed');
    }

    const text =
      data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';

    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`Gemini returned non JSON: ${text.slice(0,200)}`);
    }

  });
}

async function callGeminiImage({ model, textPrompt, aspectRatio }) {
  return withGeminiKeyRotation(async (apiKey) => {

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: textPrompt }] }],
          generationConfig: {
            responseModalities: ['TEXT','IMAGE'],
            imageConfig: { aspectRatio }
          }
        })
      }
    );

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.error?.message || 'Gemini image failed');
    }

    const part = data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);

    if (!part) throw new Error('No image returned');

    return {
      image: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
      mimeType: part.inlineData.mimeType
    };

  });
}

/* ---------------- S3 ---------------- */

function getS3Client() {
  if (
    !process.env.S3_ACCESS_KEY_ID ||
    !process.env.S3_SECRET_ACCESS_KEY ||
    !process.env.S3_REGION ||
    !process.env.S3_BUCKET_NAME
  ) return null;

  return new S3Client({
    region: process.env.S3_REGION,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
    }
  });
}

async function uploadImageToS3(dataUrl, mode) {

  const s3 = getS3Client();
  if (!s3) return null;

  const matches = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!matches) return null;

  const mime = matches[1];
  const buffer = Buffer.from(matches[2],'base64');

  const key = `generated/${mode}/${Date.now()}.png`;

  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mime
  }));

  const base = process.env.S3_PUBLIC_URL ||
    `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.S3_REGION}.amazonaws.com`;

  return `${base}/${key}`;
}

/* ---------------- DB ---------------- */

async function logGeneration(record) {

  if (!process.env.DATABASE_URL) return;

  const sql = neon(process.env.DATABASE_URL);

  try {

    await sql`
    CREATE TABLE IF NOT EXISTS fazion_generations (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      prompt TEXT,
      mode TEXT,
      image_url TEXT
    )`;

    await sql`
    INSERT INTO fazion_generations (prompt,mode,image_url)
    VALUES (${record.prompt},${record.mode},${record.imageUrl})`;

  } catch (err) {
    console.error("DB logging failed",err);
  }
}

/* ---------------- HANDLER ---------------- */

export default async (req) => {

  if (req.httpMethod === 'OPTIONS') {
    return { statusCode:204, headers:CORS };
  }

  /* debug route */
  if (req.httpMethod === 'GET') {
    return json(200,{
      ok:true,
      env: envCheck()
    });
  }

  if (req.httpMethod !== 'POST') {
    return json(405,{error:'Method not allowed'});
  }

  try {

    const body = JSON.parse(req.body || '{}');

    const { prompt, mode='realistic', aspectRatio='1:1' } = body;

    if (!prompt) {
      return json(400,{error:'Prompt required'});
    }

    const preset = MODE_PRESETS[mode];

    const routingPayload = {
      userPrompt: prompt
    };

    const refined = await callGeminiJSON({
      model: preset.routingModel,
      systemInstruction: preset.systemPrompt,
      contents: [{ role:'user', parts:[{text:JSON.stringify(routingPayload)}] }]
    });

    const productionPrompt = refined.productionPrompt || prompt;

    const generated = await callGeminiImage({
      model: preset.imageModel,
      textPrompt: productionPrompt,
      aspectRatio
    });

    let s3Url=null;

    try{
      s3Url = await uploadImageToS3(generated.image,mode);
    }catch(err){
      console.error("S3 upload failed",err);
    }

    await logGeneration({
      prompt,
      mode,
      imageUrl:s3Url
    });

    return json(200,{
      ok:true,
      image:generated.image,
      imageUrl:s3Url
    });

  } catch(err) {

    console.error("GENERATE ERROR",err);

    return json(500,{
      error:err.message || 'Unknown server error'
    });

  }

};
