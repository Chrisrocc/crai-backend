// src/routes/photoRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');

const Car = require('../models/Car');
const timeline = require('../services/logging/timelineLogger');

const {
  makeCarPhotoKey,
  uploadBufferToS3,
  getSignedViewUrl,
  getPresignedPutUrl,
  deleteObject,
} = require('../services/aws/s3');

const { analyzeAndEnrichByS3Key } = require('../services/ai/visionEnrichment');

// Multer (optional server-side upload)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// Robust decode for query keys that may be double-encoded
function robustDecode(val = '') {
  let out = String(val || '');
  try {
    const once = decodeURIComponent(out);
    // If after one decode we still see %xx, decode again
    out = /%[0-9a-f]{2}/i.test(once) ? decodeURIComponent(once) : once;
  } catch {
    // ignore and use original
  }
  return out;
}

/* =========================================================
   GET: list signed view URLs for a car
   ========================================================= */
router.get('/:carId', async (req, res) => {
  try {
    const car = await Car.findById(req.params.carId).lean();
    if (!car) return res.status(404).json({ message: 'Car not found' });

    const photos = await Promise.all(
      (car.photos || []).map(async (p) => ({
        key: p.key,
        caption: p.caption || '',
        uploadedAt: p.uploadedAt || null,
        url: await getSignedViewUrl(p.key, 3600),
      }))
    );

    res.json({ message: 'Photos retrieved', data: photos });
  } catch (err) {
    res.status(500).json({ message: 'Error getting photos', error: err.message });
  }
});

/* =========================================================
   POST: create presigned PUT URL for browser upload
   Body: { carId?: string, rego?: string, filename: string, contentType?: string }
   ========================================================= */
router.post('/presign', async (req, res) => {
  try {
    const { carId, rego, filename, contentType } = req.body || {};
    if (!carId && !rego) return res.status(400).json({ message: 'carId or rego is required' });
    if (!filename) return res.status(400).json({ message: 'filename is required' });

    const key = makeCarPhotoKey({ carId, rego, filename });
    const { uploadUrl, expiresIn } = await getPresignedPutUrl({
      key,
      contentType: contentType || 'application/octet-stream',
    });

    res.json({
      message: 'Presigned URL created',
      data: {
        key,
        uploadUrl,
        expiresIn,
        afterUpload: {
          attachEndpoint: '/photos/attach',
          attachBody: { carId, key, caption: '' },
        },
      },
    });
  } catch (err) {
    res.status(500).json({ message: 'Error creating presigned URL', error: err.message });
  }
});

/* =========================================================
   POST: attach uploaded key to car & trigger background enrichment
   Body: { carId: string, key: string, caption?: string }
   ========================================================= */
router.post('/attach', async (req, res) => {
  try {
    const { carId, key, caption = '' } = req.body || {};
    if (!carId || !key) return res.status(400).json({ message: 'carId and key are required' });

    const car = await Car.findById(carId);
    if (!car) return res.status(404).json({ message: 'Car not found' });

    const exists = (car.photos || []).some((p) => p.key === key);
    if (!exists) {
      car.photos.push({ key, caption });
      await car.save();
    }

    const url = await getSignedViewUrl(key, 3600);

    // Respond immediately so UI can render
    res.status(201).json({
      message: exists ? 'Photo already attached' : 'Photo attached',
      data: { key, caption, url },
    });

    // Background enrichment (tolerant)
    const tctx = timeline.newContext({ chatId: `upload:${carId}` });
    setImmediate(async () => {
      try {
        await analyzeAndEnrichByS3Key({ carId, key, caption }, tctx);
        timeline.change(tctx, `Enriched ${car.rego} from ${key}`);
      } catch (e) {
        console.error('vision enrich error:', e.message);
      } finally {
        timeline.print(tctx);
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error attaching photo', error: err.message });
  }
});

/* =========================================================
   (Optional) server-side upload: multipart form
   FormData: file, carId|rego, caption?
   ========================================================= */
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const { carId, rego, caption = '' } = req.body || {};
    if (!carId && !rego) return res.status(400).json({ message: 'carId or rego is required' });
    if (!req.file) return res.status(400).json({ message: 'file is required' });

    const key = makeCarPhotoKey({ carId, rego, filename: req.file.originalname });
    await uploadBufferToS3({
      key,
      buffer: req.file.buffer,
      contentType: req.file.mimetype || 'application/octet-stream',
    });

    let car = null;
    if (carId) car = await Car.findById(carId);
    else if (rego) car = await Car.findOne({ rego: String(rego).trim().toUpperCase() });
    if (!car) {
      return res.status(404).json({
        message: 'Car not found to attach photo (upload succeeded)',
        data: { key },
      });
    }

    car.photos.push({ key, caption });
    await car.save();

    const url = await getSignedViewUrl(key, 3600);
    res.status(201).json({ message: 'Photo uploaded and attached', data: { key, caption, url } });

    const tctx = timeline.newContext({ chatId: `upload:${car._id}` });
    setImmediate(async () => {
      try {
        await analyzeAndEnrichByS3Key({ carId: car._id, key, caption }, tctx);
        timeline.change(tctx, `Enriched ${car.rego} from ${key}`);
      } catch (e) {
        console.error('vision enrich error:', e.message);
      } finally {
        timeline.print(tctx);
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Error uploading photo', error: err.message });
  }
});

/* =========================================================
   PATCH: update caption
   Body: { key: string, caption?: string }
   ========================================================= */
router.patch('/:carId/caption', async (req, res) => {
  try {
    const { key, caption = '' } = req.body || {};
    if (!key) return res.status(400).json({ message: 'key is required' });

    const car = await Car.findById(req.params.carId);
    if (!car) return res.status(404).json({ message: 'Car not found' });

    const p = (car.photos || []).find((x) => x.key === key);
    if (!p) return res.status(404).json({ message: 'Photo not found on this car' });

    p.caption = caption;
    await car.save();

    res.json({ message: 'Caption updated', data: { key, caption } });
  } catch (err) {
    res.status(500).json({ message: 'Error updating caption', error: err.message });
  }
});

/* =========================================================
   DELETE: remove a photo from S3 and the car document
   Query: ?key=...
   ========================================================= */
router.delete('/:carId', async (req, res) => {
  try {
    const rawKey = req.query.key;
    if (!rawKey) return res.status(400).json({ message: 'key query param is required' });

    const key = robustDecode(rawKey);

    const car = await Car.findById(req.params.carId);
    if (!car) return res.status(404).json({ message: 'Car not found' });

    // Tolerate missing objects (deleteObject will swallow NoSuchKey)
    await deleteObject(key);

    const before = (car.photos || []).length;
    car.photos = (car.photos || []).filter((p) => p.key !== key);
    const changed = car.photos.length !== before;
    if (changed) await car.save();

    res.json({ message: 'Photo deleted', data: { key, removedFromCar: changed } });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting photo', error: err.message });
  }
});

module.exports = router;
