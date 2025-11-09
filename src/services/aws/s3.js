// src/services/aws/s3.js
require('dotenv').config();
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const {
  AWS_ACCESS_KEY_ID = '',
  AWS_SECRET_ACCESS_KEY = '',
  AWS_REGION = 'ap-southeast-2',
  AWS_BUCKET_NAME = '',
  AWS_S3_ENDPOINT = '',
  AWS_S3_FORCE_PATH_STYLE = '',
} = process.env;

// ---------- Diagnostics ----------
const missing = [];
if (!AWS_BUCKET_NAME) missing.push('AWS_BUCKET_NAME');
const S3_DISABLED = missing.length > 0;

if (S3_DISABLED) {
  console.error('[S3] ❌ Disabled — missing env:', missing.join(', '));
} else {
  console.log(`[S3] ✅ Enabled for bucket: ${AWS_BUCKET_NAME}`);
  if (AWS_S3_ENDPOINT) console.log('[S3] Using custom endpoint:', AWS_S3_ENDPOINT);
}

let s3 = null;
let BUCKET = AWS_BUCKET_NAME;

if (!S3_DISABLED) {
  const clientConfig = {
    region: AWS_REGION || 'auto',
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  };

  if (AWS_S3_ENDPOINT) {
    clientConfig.endpoint = AWS_S3_ENDPOINT;
    clientConfig.forcePathStyle = String(AWS_S3_FORCE_PATH_STYLE).toLowerCase() === 'true';
  }

  s3 = new S3Client(clientConfig);
}

// ---------- Helpers ----------
function safeSlug(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_.]/g, '')
    .slice(0, 80) || 'unknown';
}

function timeStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function requireEnabled() {
  if (S3_DISABLED) {
    const msg = `[S3] Feature disabled — missing env: ${missing.join(', ')}`;
    const error = new Error(msg);
    error.code = 'S3_DISABLED';
    throw error;
  }
}

/** Build a stable S3 key for a car photo */
function makeCarPhotoKey({ carId, rego, filename }) {
  const base = carId ? `car-${safeSlug(carId)}` : `rego-${safeSlug(rego)}`;
  const name = filename ? safeSlug(path.basename(filename)) : `upload-${timeStamp()}.jpg`;
  return `cars/${base}/${timeStamp()}-${name}`;
}

// ---------- Core functions ----------
async function uploadBufferToS3({ key, buffer, contentType = 'application/octet-stream' }) {
  requireEnabled();
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });
  await s3.send(cmd);
  return { bucket: BUCKET, key };
}

/** Get a presigned GET (view) URL */
async function getSignedViewUrl(key, expiresInSeconds = 3600) {
  requireEnabled();
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  const url = await getSignedUrl(s3, cmd, { expiresIn: expiresInSeconds });
  return url;
}

/** Get a presigned PUT (upload) URL */
async function getPresignedPutUrl({ key, contentType = 'application/octet-stream', expiresInSeconds = 86400 }) {
  requireEnabled();
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
  const url = await getSignedUrl(s3, cmd, { expiresIn: expiresInSeconds });
  return { key, uploadUrl: url, expiresIn: expiresInSeconds };
}

/** Delete object (tolerates non-existent) */
async function deleteObject(key) {
  requireEnabled();
  const cmd = new DeleteObjectCommand({ Bucket: BUCKET, Key: key });
  try {
    await s3.send(cmd);
  } catch (e) {
    const code = (e?.name || e?.Code || e?.code || '').toLowerCase();
    if (code.includes('nosuchkey')) {
      console.warn('[S3] deleteObject: key did not exist, ignoring:', key);
    } else throw e;
  }
  return { key, deleted: true };
}

// ---------- Exports ----------
module.exports = {
  s3,
  BUCKET,
  S3_DISABLED,
  makeCarPhotoKey,
  uploadBufferToS3,
  getSignedViewUrl,
  getPresignedPutUrl,
  deleteObject,
};
