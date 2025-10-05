// src/services/aws/s3.js
require('dotenv').config();

const {
  AWS_ACCESS_KEY_ID = '',
  AWS_SECRET_ACCESS_KEY = '',
  AWS_REGION = '',
  AWS_BUCKET_NAME = '',
  // Optional extras (safe to leave unset)
  AWS_S3_ENDPOINT = '',              // e.g. https://s3.amazonaws.com or a MinIO/R2 endpoint
  AWS_S3_FORCE_PATH_STYLE = '',      // 'true' to force path-style URLs if using custom endpoints
} = process.env;

// ---------- Diagnostics (one-time, safe) ----------
const missing = [];
if (!AWS_BUCKET_NAME) missing.push('AWS_BUCKET_NAME');
if (!AWS_REGION) missing.push('AWS_REGION');

const S3_DISABLED = missing.length > 0;

if (S3_DISABLED) {
  console.error(
    '[S3] Disabled — missing env:',
    missing.join(', '),
    '→ Set these in Railway Variables to enable photo uploads.'
  );
} else {
  console.log('[S3] Enabled for bucket:', AWS_BUCKET_NAME, 'region:', AWS_REGION);
  // Helpful for future debugging without revealing full secrets:
  if (AWS_ACCESS_KEY_ID) console.log('[S3] Using static credentials (access key id length):', AWS_ACCESS_KEY_ID.length);
  if (AWS_S3_ENDPOINT) console.log('[S3] Custom endpoint:', AWS_S3_ENDPOINT);
}

// ---------- Client creation (only if enabled) ----------
let s3 = null;
let BUCKET = AWS_BUCKET_NAME;

if (!S3_DISABLED) {
  const { S3Client } = require('@aws-sdk/client-s3');

  const clientConfig = {
    region: AWS_REGION,
  };

  // Optional: static credentials (otherwise SDK will use env/role/instance creds)
  if (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) {
    clientConfig.credentials = {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    };
  }

  // Optional: custom endpoint (MinIO/R2/etc.)
  if (AWS_S3_ENDPOINT) {
    clientConfig.endpoint = AWS_S3_ENDPOINT;
    if (String(AWS_S3_FORCE_PATH_STYLE).toLowerCase() === 'true') {
      clientConfig.forcePathStyle = true;
    }
  }

  s3 = new S3Client(clientConfig);
}

// ---------- Helpers ----------
const path = require('path');
function safeSlug(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_.]/g, '')
    .slice(0, 80) || 'unknown';
}

function timeStamp() {
  // e.g. 2025-08-28T05-12-31-123Z -> 2025-08-28T05-12-31-123Z (safe in key paths)
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function requireEnabled() {
  if (S3_DISABLED) {
    const msg =
      `[S3] Feature disabled — missing env: ${missing.join(', ')}. ` +
      `Set these in Railway Variables and redeploy to enable photo uploads.`;
    const error = new Error(msg);
    error.code = 'S3_DISABLED';
    throw error;
  }
}

/**
 * Build an S3 object key for a car photo.
 * Prefer carId if you have it; otherwise fall back to rego.
 */
function makeCarPhotoKey({ carId, rego, filename }) {
  const base = carId ? `car-${safeSlug(carId)}` : `rego-${safeSlug(rego)}`;
  const name = filename ? safeSlug(path.basename(filename)) : `upload-${timeStamp()}.jpg`;
  return `cars/${base}/${timeStamp()}-${name}`;
}

// ---------- Public API (no-ops if disabled) ----------
async function uploadBufferToS3({ key, buffer, contentType = 'application/octet-stream', acl = undefined }) {
  requireEnabled();
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ...(acl ? { ACL: acl } : {}),
  });
  await s3.send(cmd);
  return { bucket: BUCKET, key };
}

async function getSignedViewUrl(key, expiresInSeconds = 3600) {
  requireEnabled();
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: expiresInSeconds });
}

async function getPresignedPutUrl({ key, contentType = 'application/octet-stream', expiresInSeconds = 3600 }) {
  requireEnabled();
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: expiresInSeconds });
  return { key, uploadUrl: url, expiresIn: expiresInSeconds };
}

async function deleteObject(key) {
  requireEnabled();
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const cmd = new DeleteObjectCommand({ Bucket: BUCKET, Key: key });
  await s3.send(cmd);
  return { key, deleted: true };
}

module.exports = {
  // Expose for other modules/tests
  s3,
  BUCKET,
  S3_DISABLED,
  makeCarPhotoKey,
  uploadBufferToS3,
  getSignedViewUrl,
  getPresignedPutUrl,
  deleteObject,
};
