// src/services/aws/s3.js
require('dotenv').config();

const {
  AWS_ACCESS_KEY_ID = '',
  AWS_SECRET_ACCESS_KEY = '',
  AWS_REGION = '',
  AWS_BUCKET_NAME = '',
  AWS_S3_ENDPOINT = '',
  AWS_S3_FORCE_PATH_STYLE = '',
} = process.env;

// ---------- Diagnostics ----------
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
    if (AWS_ACCESS_KEY_ID) console.log('[S3] Using static credentials (access key id length):', AWS_ACCESS_KEY_ID.length);
    if (AWS_S3_ENDPOINT) console.log('[S3] Custom endpoint:', AWS_S3_ENDPOINT);
}

let s3 = null;
let BUCKET = AWS_BUCKET_NAME;

if (!S3_DISABLED) {
  const { S3Client } = require('@aws-sdk/client-s3');
  const clientConfig = { region: AWS_REGION };
  if (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) {
    clientConfig.credentials = {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    };
  }
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

/** Build a stable S3 key for a car photo. */
function makeCarPhotoKey({ carId, rego, filename }) {
  const base = carId ? `car-${safeSlug(carId)}` : `rego-${safeSlug(rego)}`;
  const name = filename ? safeSlug(path.basename(filename)) : `upload-${timeStamp()}.jpg`;
  return `cars/${base}/${timeStamp()}-${name}`;
}

// ---------- Public API ----------
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

async function getPresignedPutUrl({ key, contentType = 'application/octet-stream', expiresInSeconds = 86400 }) {
  requireEnabled();
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
  const url = await getSignedUrl(s3, cmd, { expiresIn: expiresInSeconds });
  return { key, uploadUrl: url, expiresIn: expiresInSeconds };
}

async function deleteObject(key) {
  requireEnabled();
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const cmd = new DeleteObjectCommand({ Bucket: BUCKET, Key: key });
  try {
    await s3.send(cmd);
  } catch (e) {
    // Tolerate "not found" deletes so API doesn't 500
    const code = e?.name || e?.Code || e?.code || '';
    if (String(code).toLowerCase().includes('nosuchkey')) {
      console.warn('[S3] deleteObject: key did not exist, treating as deleted:', key);
    } else {
      throw e;
    }
  }
  return { key, deleted: true };
}

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
