// src/routes/cars.js
const express = require("express");
const router = express.Router();
const Car = require("../models/Car");

const { decideCategoryForChecklist } = require("../services/ai/categoryDecider");
const { upsertReconFromChecklist } = require("../services/reconUpsert");
const { normalizeChecklist } = require("../services/ai/checklistDeduper");
const { getSignedViewUrl } = require("../services/aws/s3");

// ---------- helpers ----------
const normalizeRego = (s) =>
  typeof s === "string" ? s.toUpperCase().replace(/[^A-Z0-9]/g, "") : s;

const toCsvArray = (val) => {
  if (Array.isArray(val)) return [...new Set(val.map((s) => String(s).trim()).filter(Boolean))];
  if (typeof val === "string") return [...new Set(val.split(",").map((s) => s.trim()).filter(Boolean))];
  return [];
};

const dedupePush = (arr, value) => {
  const v = String(value || "").trim();
  if (!v) return arr;
  if (!Array.isArray(arr)) arr = [];
  if (!arr.includes(v)) arr.push(v);
  return arr;
};

const normalizeList = (arr) =>
  [...new Set((Array.isArray(arr) ? arr : []).map((s) => String(s).trim()).filter(Boolean))];

const stripCurrentFromNext = (nextArr, currentLoc) => {
  const next = normalizeList(nextArr);
  const curr = String(currentLoc || "").trim();
  if (!curr) return next;
  const currLC = curr.toLowerCase();
  return next.filter((n) => n.toLowerCase() !== currLC);
};

const msPerDay = 1000 * 60 * 60 * 24;
const dateOnly = (d) => {
  const dt = new Date(d || Date.now());
  dt.setHours(0, 0, 0, 0);
  return dt;
};
const daysClosed = (start, end) => {
  const s = dateOnly(start).getTime();
  const e = dateOnly(end).getTime();
  const diff = Math.max(0, e - s);
  return Math.max(1, Math.floor(diff / msPerDay));
};

// compute which checklist items are newly added (after normalization)
function diffNewChecklistItems(oldList, newList) {
  const norm = (s) => String(s || "").trim().toLowerCase();
  const oldSet = new Set((Array.isArray(oldList) ? oldList : []).map(norm).filter(Boolean));
  const added = [];
  for (const x of Array.isArray(newList) ? newList : []) {
    const t = String(x || "").trim();
    if (t && !oldSet.has(norm(t))) added.push(t);
  }
  return added;
}

// ---------- DELETE ----------
router.delete("/:id", async (req, res) => {
  try {
    const doc = await Car.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ message: "Car not found" });
    res.status(204).end();
  } catch (err) {
    console.error("Delete car error:", err);
    res.status(400).json({ message: "Error deleting car", error: err.message });
  }
});

// ---------- GET ALL ----------
router.get("/", async (_req, res) => {
  try {
    const cars = await Car.find().lean();
    res.json({ message: "Cars retrieved successfully", data: cars });
  } catch (err) {
    res.status(500).json({ message: "Error retrieving cars", error: err.message });
  }
});

// ---------- CREATE ----------
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const payload = {
      rego: normalizeRego(body.rego),
      make: body.make?.trim() || "",
      model: body.model?.trim() || "",
      badge: body.badge?.trim() || "",
      series: body.series?.trim() || "",
      year: typeof body.year === "number"
        ? body.year
        : (String(body.year || "").trim() ? Number(body.year) : undefined),
      description: body.description?.trim() || "",
      checklist: normalizeChecklist(toCsvArray(body.checklist || [])),
      location: body.location?.trim() || "",
      nextLocations: [],
      readinessStatus: body.readinessStatus?.trim() || "",
      stage: body.stage?.trim() || "In Works",
      notes: body.notes?.trim() || "",
      history: [],
    };

    if (payload.location) {
      payload.history.push({
        location: payload.location,
        startDate: new Date(),
        endDate: null,
        days: 0,
      });
    }

    if (typeof body.nextLocation === "string" && body.nextLocation.trim()) {
      payload.nextLocations = dedupePush(payload.nextLocations || [], body.nextLocation);
    } else if (Array.isArray(body.nextLocations)) {
      payload.nextLocations = [
        ...new Set(body.nextLocations.map((s) => String(s).trim()).filter(Boolean)),
      ];
    }

    payload.nextLocations = stripCurrentFromNext(payload.nextLocations, payload.location);
    const doc = new Car(payload);
    doc.checklist = normalizeChecklist(doc.checklist);
    await doc.save();
    res.status(201).json({ message: "Car created successfully", data: doc.toJSON() });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern?.rego) {
      return res.status(409).json({ message: "A car with this rego already exists." });
    }
    res.status(400).json({ message: "Error creating car", error: err.message });
  }
});

// ---------- UPDATE ----------
router.put("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const body = req.body || {};
    const doc = await Car.findById(id);
    if (!doc) return res.status(404).json({ message: "Car not found" });

    const beforeChecklist = normalizeChecklist(doc.checklist || []);

    if (body.rego !== undefined) doc.rego = normalizeRego(body.rego || "");
    if (body.make !== undefined) doc.make = String(body.make || "").trim();
    if (body.model !== undefined) doc.model = String(body.model || "").trim();
    if (body.badge !== undefined) doc.badge = String(body.badge || "").trim();
    if (body.series !== undefined) doc.series = String(body.series || "").trim();

    if (body.year !== undefined) {
      const y = String(body.year).trim();
      doc.year = y ? Number(y) : undefined;
    }

    if (body.description !== undefined) doc.description = String(body.description || "").trim();

    if (body.checklist !== undefined) {
      doc.checklist = normalizeChecklist(toCsvArray(body.checklist));
    }

    if (Array.isArray(body.nextLocations)) {
      doc.nextLocations = [
        ...new Set(body.nextLocations.map((s) => String(s).trim()).filter(Boolean)),
      ];
    } else if (typeof body.nextLocation === "string" && body.nextLocation.trim()) {
      doc.nextLocations = dedupePush(doc.nextLocations || [], body.nextLocation);
    }

    if (body.readinessStatus !== undefined)
      doc.readinessStatus = String(body.readinessStatus || "").trim();
    if (body.stage !== undefined) doc.stage = String(body.stage || "").trim();
    if (body.notes !== undefined) doc.notes = String(body.notes || "").trim();

    // Handle location changes
    if (body.location !== undefined) {
      const newLoc = String(body.location || "").trim();
      const prevLoc = doc.location || "";

      if (newLoc && newLoc !== prevLoc) {
        if (Array.isArray(doc.history) && doc.history.length) {
          const last = doc.history[doc.history.length - 1];
          if (last && !last.endDate) {
            last.endDate = new Date();
            last.days = daysClosed(last.startDate, last.endDate);
          }
        } else doc.history = [];

        doc.history.push({
          location: newLoc,
          startDate: new Date(),
          endDate: null,
          days: 0,
        });

        doc.location = newLoc;
      }
    }

    doc.checklist = normalizeChecklist(doc.checklist || []);
    await doc.save();

    const afterChecklist = normalizeChecklist(doc.checklist || []);
    const newlyAdded = diffNewChecklistItems(beforeChecklist, afterChecklist);
    if (newlyAdded.length) {
      for (const itemText of newlyAdded) {
        try {
          const decided = await decideCategoryForChecklist(itemText, null);
          await upsertReconFromChecklist(
            { carId: doc._id, categoryName: decided.categoryName, noteText: itemText },
            null
          );
        } catch (e) {
          console.error("Checklist ingest error:", e.message);
        }
      }
    }

    res.json({ message: "Car updated successfully", data: doc.toJSON() });
  } catch (err) {
    console.error("Update car error:", err);
    res.status(400).json({ message: "Error updating car", error: err.message });
  }
});

// ---------- PHOTO PREVIEW ----------
router.get("/:carId/photo-preview", async (req, res) => {
  try {
    const car = await Car.findById(req.params.carId);
    if (!car || !car.photos?.length) {
      console.log(`🚫 No photos for carId ${req.params.carId}`);
      return res.json({ data: null });
    }

    const first = car.photos[0];
    let key = first.key || first;
    if (key.startsWith("http")) {
      const urlObj = new URL(key);
      key = urlObj.pathname.replace(/^\/+/, "");
    }

    const signedUrl = await getSignedViewUrl(key, 3600);
    console.log(`🖼️ Signed preview generated for ${car.rego}:`, signedUrl);
    res.json({ data: signedUrl });
  } catch (e) {
    console.error("❌ [PHOTO PREVIEW FAIL]", e);
    res.status(500).json({ message: e.message });
  }
});

// ---------- PUBLIC CONTROLLER: resolve rego ----------
async function resolveRegoController(req, res) {
  try {
    const rego = String(req.body?.rego || "").trim().toUpperCase();
    if (!rego) return res.status(400).json({ message: "rego is required" });

    const car = await Car.findOne({ rego }).lean();
    if (!car) return res.status(404).json({ message: "Car not found" });

    res.json({ message: "Car found", data: car });
  } catch (err) {
    console.error("[resolveRegoController] error:", err);
    res.status(500).json({ message: "Error resolving rego", error: err.message });
  }
}

module.exports = router;
module.exports.resolveRegoController = resolveRegoController;
