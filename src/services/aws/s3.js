// src/services/aws/s3.js
require('dotenv').config();
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');

const {
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_REGION,
  AWS_BUCKET_NAME,
} = process.env;

if (!AWS_BUCKET_NAME) throw new Error('Missing AWS_BUCKET_NAME');
if (!AWS_REGION) throw new Error('Missing AWS_REGION');

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY)
    ? { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY }
    : undefined, // if running on AWS with a role, creds can come from env/role
});

const BUCKET = AWS_BUCKET_NAME;

function safeSlug(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_.]/g, '')
    .slice(0, 80) || 'unknown';
}

function timeStamp() {
  // e.g. 2025-08-28T05-12-31-123Z
  return new Date().toISOString().replace(/[:.]/g, '-');
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

async function uploadBufferToS3({ key, buffer, contentType = 'application/octet-stream', acl = undefined }) {
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
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: expiresInSeconds });
}

async function getPresignedPutUrl({ key, contentType = 'application/octet-stream', expiresInSeconds = 3600 }) {
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: expiresInSeconds });
  return { key, uploadUrl: url, expiresIn: expiresInSeconds };
}

async function deleteObject(key) {
  const cmd = new DeleteObjectCommand({ Bucket: BUCKET, Key: key });
  await s3.send(cmd);
  return { key, deleted: true };
}

module.exports = {
  s3,
  BUCKET,
  makeCarPhotoKey,
  uploadBufferToS3,
  getSignedViewUrl,
  getPresignedPutUrl,
  deleteObject,
};
