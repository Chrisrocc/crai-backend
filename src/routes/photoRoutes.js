const express = require("express");
const router = express.Router();
const multer = require("multer");

const Car = require("../models/Car");
const timeline = require("../services/logging/timelineLogger");
const {
  makeCarPhotoKey,
  uploadBufferToS3,
  getSignedViewUrl,
  getPresignedPutUrl,
  deleteObject,
} = require("../services/aws/s3");
const { analyzeAndEnrichByS3Key } = require("../services/ai/visionEnrichment");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function robustDecode(val = "") {
  let out = String(val || "");
  try {
    const once = decodeURIComponent(out);
    out = /%[0-9a-f]{2}/i.test(once) ? decodeURIComponent(once) : once;
  } catch {}
  return out;
}

/* ================= GET ================= */
router.get("/:carId", async (req, res) => {
  try {
    console.log(`📸 [GET] carId=${req.params.carId}`);
    const car = await Car.findById(req.params.carId).lean();
    if (!car) return res.status(404).json({ message: "Car not found" });

    const photos = await Promise.all(
      (car.photos || []).map(async (p) => ({
        key: p.key,
        caption: p.caption || "",
        uploadedAt: p.uploadedAt || null,
        url: await getSignedViewUrl(p.key, 3600),
      }))
    );

    console.log(`✅ [GET] ${photos.length} photos`);
    res.json({ data: photos });
  } catch (e) {
    console.error("❌ [GET FAIL]", e.message);
    res.status(500).json({ message: e.message });
  }
});

/* ================= PRESIGN ================= */
router.post("/presign", async (req, res) => {
  try {
    const { carId, rego, filename, contentType } = req.body || {};
    if (!carId && !rego)
      return res.status(400).json({ message: "carId or rego required" });
    if (!filename) return res.status(400).json({ message: "filename required" });

    const key = makeCarPhotoKey({ carId, rego, filename });
    const { uploadUrl, expiresIn } = await getPresignedPutUrl({
      key,
      contentType,
    });

    console.log("✅ [PRESIGN]", key);
    res.json({ data: { key, uploadUrl, expiresIn } });
  } catch (e) {
    console.error("❌ [PRESIGN FAIL]", e.message);
    res.status(500).json({ message: e.message });
  }
});

/* ================= ATTACH ================= */
router.post("/attach", async (req, res) => {
  try {
    const { carId, key, caption = "" } = req.body || {};
    console.log(`🔗 [ATTACH] ${carId} ${key}`);

    const car = await Car.findById(carId);
    if (!car) return res.status(404).json({ message: "Car not found" });

    const exists = (car.photos || []).some((p) => p.key === key);
    if (!exists) {
      car.photos.push({ key, caption });
      await car.save();
    }

    const url = await getSignedViewUrl(key, 3600);
    res.status(201).json({ data: { key, caption, url } });

    // Background enrichment
    const tctx = timeline.newContext({ chatId: `upload:${carId}` });
    setImmediate(async () => {
      try {
        await analyzeAndEnrichByS3Key({ carId, key, caption }, tctx);
        timeline.change(tctx, `Enriched ${car.rego} from ${key}`);
      } catch (e) {
        console.error("💥 [VISION]", e.message);
      } finally {
        timeline.print(tctx);
      }
    });
  } catch (e) {
    console.error("❌ [ATTACH FAIL]", e.message);
    res.status(500).json({ message: e.message });
  }
});

/* ================= DELETE ================= */
router.delete("/:carId", async (req, res) => {
  try {
    const rawKey = req.query.key;
    const key = robustDecode(rawKey);
    const car = await Car.findById(req.params.carId);
    if (!car) return res.status(404).json({ message: "Car not found" });

    await deleteObject(key);
    car.photos = (car.photos || []).filter((p) => p.key !== key);
    await car.save();

    console.log(`🗑 [DELETE] ${key}`);
    res.json({ message: "deleted", key });
  } catch (e) {
    console.error("❌ [DELETE FAIL]", e.message);
    res.status(500).json({ message: e.message });
  }
});

/* ================= REORDER ================= */
router.put("/reorder/:carId", async (req, res) => {
  try {
    const { carId } = req.params;
    const { photos = [] } = req.body || {};

    if (!Array.isArray(photos))
      return res.status(400).json({ message: "photos must be an array" });

    const car = await Car.findById(carId);
    if (!car) return res.status(404).json({ message: "Car not found" });

    car.photos = photos.map((p) => ({
      key: p.key,
      caption: p.caption || "",
    }));

    await car.save();
    console.log(`✅ [REORDER] Saved new photo order for ${car.rego || carId}`);

    res.json({ message: "ok", count: car.photos.length });
  } catch (e) {
    console.error("❌ [REORDER FAIL]", e.message);
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;
