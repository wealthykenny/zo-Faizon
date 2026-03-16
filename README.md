# Fazion for Netlify

Netlify-ready version of Fazion with:
- Faizon Realistic
- Faizon Aesthetics
- 5-key Gemini rotation
- Neon logging
- optional S3 storage for generated images
- S3 object tagging for auto-delete workflow

## Netlify environment variables
Add these in Netlify Site configuration -> Environment variables:

Required:
- GEMINI_API_KEY_1
- GEMINI_API_KEY_2
- GEMINI_API_KEY_3
- GEMINI_API_KEY_4
- GEMINI_API_KEY_5

Optional:
- DATABASE_URL
- AWS_REGION
- AWS_ACCESS_KEY_ID
- AWS_SECRET_ACCESS_KEY
- S3_BUCKET_NAME
- AWS_S3_PUBLIC_URL

## Important: 2-day image deletion
The app uploads generated images to the `generated/` prefix in S3 and tags each object with:
- autodelete=true
- ttl=2days

The actual deletion after 2 days should be enforced by an S3 Lifecycle Rule on the bucket. Configure the rule to expire objects in the `generated/` prefix after 2 days.

If S3 variables are not set, the app still works and returns a data URL directly from Gemini.

## Deploy
1. Create a new Netlify site from this folder or upload this zip manually.
2. Set the environment variables.
3. Deploy.

## Notes
- Gemini keys are server-side only in Netlify Functions.
- Do not expose Gemini keys in frontend code.
