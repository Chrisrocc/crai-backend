

// src/routes/cars.js
const express = require("express");
const router = express.Router();
const Car = require("../models/Car");

// AI helpers
const { decideCategoryForChecklist } = require("../services/ai/categoryDecider");
const { upsertReconFromChecklist } = require("../services/reconUpsert");
const { getSignedViewUrl } = require("../services/aws/s3");

// checklist deduper: support both `module.exports = fn` and `{ normalizeChecklist }`
const checklistDeduper = require("../services/ai/checklistDeduper");
const normalizeChecklistRaw =
  typeof checklistDeduper === "function"
    ? checklistDeduper
    : checklistDeduper && typeof checklistDeduper.normalizeChecklist === "function"
    ? checklistDeduper.normalizeChecklist
    : null;

const normalizeChecklist = (input) => {
  if (normalizeChecklistRaw) return normalizeChecklistRaw(input);
  // safe fallback: ensure array of trimmed unique strings
  const arr = Array.isArray(input) ? input : [];
  return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
};

// ---------- helpers ----------
const normalizeRego = (s) =>
  typeof s === "string" ? s.toUpperCase().replace(/[^A-Z0-9]/g, "") : s;

const toCsvArray = (val) => {
  if (Array.isArray(val))
    return [...new Set(val.map((s) => String(s).trim()).filter(Boolean))];
  if (typeof val === "string")
    return [...new Set(val.split(",").map((s) => s.trim()).filter(Boolean))];
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

function diffNewChecklistItems(oldList, newList) {
  const norm = (s) => String(s || "").trim().toLowerCase();
  const oldSet = new Set((Array.isArray(oldList) ? oldList : []).map(norm).filter(Boolean));
  const added = [];
  for (const x of (Array.isArray(newList) ? newList : [])) {
    const t = String(x || "").trim();
    if (t && !oldSet.has(norm(t))) added.push(t);
  }
  return added;
}

// ---------- DELETE /api/cars/:id ----------
router.delete("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await Car.findByIdAndDelete(id);
    if (!doc) return res.status(404).json({ message: "Car not found" });
    return res.status(204).end();
  } catch (err) {
    console.error("Delete car error:", err);
    return res.status(400).json({ message: "Error deleting car", error: err.message });
  }
});

// ---------- GET /api/cars ----------
router.get("/", async (_req, res) => {
  try {
    const cars = await Car.find().lean();
    res.json({ message: "Cars retrieved successfully", data: cars });
  } catch (err) {
    res.status(500).json({ message: "Error retrieving cars", error: err.message });
  }
});

// ---------- POST /api/cars ----------
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const payload = {
      rego: normalizeRego(body.rego),
      make: body.make?.trim() || "",
      model: body.model?.trim() || "",
      badge: body.badge?.trim() || "",
      series: body.series?.trim() || "",
      year:
        typeof body.year === "number"
          ? body.year
          : String(body.year || "").trim()
          ? Number(body.year)
          : undefined,
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
      payload.nextLocations = dedupePush(
        payload.nextLocations || [],
        body.nextLocation
      );
    } else if (Array.isArray(body.nextLocations)) {
      payload.nextLocations = [
        ...new Set(
          body.nextLocations.map((s) => String(s).trim()).filter(Boolean)
        ),
      ];
    }

    payload.nextLocations = stripCurrentFromNext(
      payload.nextLocations,
      payload.location
    );

    const doc = new Car(payload);
    doc.checklist = normalizeChecklist(doc.checklist);
    await doc.save();

    res.status(201).json({ message: "Car created successfully", data: doc.toJSON() });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern && err.keyPattern.rego) {
      return res.status(409).json({ message: "A car with this rego already exists." });
    }
    res.status(400).json({ message: "Error creating car", error: err.message });
  }
});



// ---------- PUT /api/cars/:id ----------
router.put("/:id", async (req, res) => {
  try {
    // Ignore accidental PUTs from /photos helper paths
    if (req.originalUrl.includes("/photos/")) {
      console.log("⏩ Skipping cars PUT because it's from photo route");
      return res.status(400).json({ message: "Invalid cars PUT call" });
    }

    const id = req.params.id;
    const body = req.body || {};
    const doc = await Car.findById(id);
    if (!doc) return res.status(404).json({ message: "Car not found" });

    const beforeChecklist = normalizeChecklist(doc.checklist || []);

    // -------------- BASIC FIELDS --------------
    if (body.rego !== undefined) doc.rego = normalizeRego(body.rego || "");
    if (body.make !== undefined) doc.make = String(body.make || "").trim();
    if (body.model !== undefined) doc.model = String(body.model || "").trim();
    if (body.badge !== undefined) doc.badge = String(body.badge || "").trim();
    if (body.series !== undefined) doc.series = String(body.series || "").trim();

    if (body.year !== undefined) {
      const y = String(body.year).trim();
      doc.year = y ? Number(y) : undefined;
    }

    if (body.description !== undefined)
      doc.description = String(body.description || "").trim();

    if (body.checklist !== undefined) {
      doc.checklist = normalizeChecklist(toCsvArray(body.checklist));
    }

    // -------------- NEXT LOCATIONS --------------
    if (Array.isArray(body.nextLocations)) {
      doc.nextLocations = [
        ...new Set(
          body.nextLocations.map((s) => String(s).trim()).filter(Boolean)
        ),
      ];
    } else if (
      typeof body.nextLocation === "string" &&
      body.nextLocation.trim()
    ) {
      doc.nextLocations = dedupePush(
        doc.nextLocations || [],
        body.nextLocation
      );
    }

    if (body.readinessStatus !== undefined)
      doc.readinessStatus = String(body.readinessStatus || "").trim();

    // -------------- *** YOUR NEW LOGIC HERE *** --------------
    //
    // If car is "Online" AND has >=1 checklist item → change to "In Works/Online"
    // If car has NO checklist items and user manually puts Online → keep Online
    //
    // Applies to BOTH frontend PUT and Autogate sync.
    //
    if (body.stage !== undefined) {
      let incoming = String(body.stage || "").trim();
      const hasChecklist = doc.checklist && doc.checklist.length > 0;

      if (/^online$/i.test(incoming) && hasChecklist) {
        incoming = "In Works/Online";
      }

      doc.stage = incoming;
    }

    if (body.notes !== undefined) doc.notes = String(body.notes || "").trim();

    // -------------- LOCATION + HISTORY --------------
    {
      const incomingLoc =
        body.location !== undefined
          ? String(body.location || "").trim()
          : doc.location || "";

      doc.nextLocations = stripCurrentFromNext(
        doc.nextLocations,
        incomingLoc
      );
    }

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
        } else {
          doc.history = [];
        }

        doc.history.push({
          location: newLoc,
          startDate: new Date(),
          endDate: null,
          days: 0,
        });

        doc.location = newLoc;
      } else if (!prevLoc && newLoc) {
        if (!Array.isArray(doc.history)) doc.history = [];
        doc.history.push({
          location: newLoc,
          startDate: new Date(),
          endDate: null,
          days: 0,
        });
        doc.location = newLoc;
      } else if (!newLoc && prevLoc) {
        if (Array.isArray(doc.history) && doc.history.length) {
          const last = doc.history[doc.history.length - 1];
          if (last && !last.endDate) {
            last.endDate = new Date();
            last.days = daysClosed(last.startDate, last.endDate);
          }
        }
        doc.location = "";
      }

      doc.nextLocations = stripCurrentFromNext(
        doc.nextLocations,
        doc.location
      );
    }

    // -------------- PHOTO ORDER SYNC --------------
    if (Array.isArray(body.photos)) {
      doc.photos = body.photos.map((p) => ({
        key: p.key,
        caption: p.caption || "",
      }));
      doc.markModified("photos");
    }

    doc.checklist = normalizeChecklist(doc.checklist || []);
    await doc.save();

    // -------------- RECON AUTOGEN LOGIC --------------
    try {
      const afterChecklist = normalizeChecklist(doc.checklist || []);
      const newlyAdded = diffNewChecklistItems(beforeChecklist, afterChecklist);

      if (newlyAdded.length) {
        const label =
          [
            doc.rego,
            [doc.make, doc.model].filter(Boolean).join(" "),
          ]
            .filter(Boolean)
            .join(" — ") || String(doc._id);

        for (const itemText of newlyAdded) {
          const trimmed = String(itemText || "").trim();
          try {
            console.log(`- checklist item added : ${label} — "${trimmed}"`);
            let decided = { categoryName: "Other", service: "" };
            try {
              decided = await decideCategoryForChecklist(trimmed, null);
            } catch (e) {
              console.error(
                `- AI analysis failed, defaulting to "Other":`,
                e.message
              );
            }
            console.log(
              `- AI analysis: ${decided.categoryName || "Other"} (service: ${
                decided.service || "-"
              })`
            );
            const result = await upsertReconFromChecklist(
              {
                carId: doc._id,
                categoryName: decided.categoryName,
                noteText: trimmed,
                service: decided.service,
              },
              null
            );
            if (result?.created) {
              console.log(
                `- Recon Appointment created [${decided.categoryName}] with note "${trimmed}"`
              );
            } else if (result?.updated) {
              console.log(
                `- Recon notes updated [${decided.categoryName}] add "${trimmed}"`
              );
            } else {
              console.log(
                `- No change (already present) in "${decided.categoryName}"`
              );
            }
          } catch (e) {
            console.error(
              `- checklist ingest error (car ${doc._id}):`,
              e.stack || e.message
            );
          }
        }
      }
    } catch (e) {
      console.error("post-save ingest block failed:", e.stack || e.message);
    }

    res.json({ message: "Car updated successfully", data: doc.toJSON() });
  } catch (err) {
    if (err.code === 11000 && err.keyPattern && err.keyPattern.rego) {
      return res
        .status(409)
        .json({ message: "A car with this rego already exists." });
    }
    console.error("Update car error:", err);
    res.status(400).json({ message: "Error updating car", error: err.message });
  }
});



// ---------- DELETE /api/cars/:id ----------
router.delete("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await Car.findById(id);
    if (!doc) return res.status(404).json({ message: "Car not found" });

    // Delete associated S3 photos
    try {
      const keys = (doc.photos || []).map((p) => p.key).filter(Boolean);
      if (keys.length) {
        console.log(`Deleting ${keys.length} photos from S3…`);
        await deleteFromS3(keys);
      }
    } catch (err) {
      console.error("Photo delete error:", err.message);
    }

    await Car.deleteOne({ _id: id });

    res.json({ message: "Car deleted successfully" });
  } catch (err) {
    console.error("Delete car error:", err);
    res.status(400).json({ message: "Error deleting car", error: err.message });
  }
});

// ---------- GET /api/cars/:id (single car) ----------
router.get("/:id", async (req, res) => {
  try {
    const doc = await Car.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ message: "Car not found" });

    // Signed URLs for frontend
    const photos = await Promise.all(
      (doc.photos || []).map(async (p) => ({
        key: p.key,
        caption: p.caption || "",
        url: await getSignedViewUrl(p.key),
      }))
    );

    doc.photos = photos;

    res.json(doc);
  } catch (err) {
    console.error("Fetch car error:", err);
    res.status(400).json({ message: "Error fetching car", error: err.message });
  }
});

// ---------- SEARCH /api/cars/search ----------
router.get("/search/:query", async (req, res) => {
  const q = String(req.params.query || "").trim();
  if (!q) return res.json([]);

  const regex = new RegExp(q.replace(/[^a-zA-Z0-9]/g, ""), "i");

  const docs = await Car.find({
    $or: [
      { rego: regex },
      { make: new RegExp(q, "i") },
      { model: new RegExp(q, "i") },
      { description: new RegExp(q, "i") },
    ],
  })
    .limit(20)
    .lean();

  // add signed URLs
  for (const car of docs) {
    car.photos = await Promise.all(
      (car.photos || []).map(async (p) => ({
        key: p.key,
        caption: p.caption || "",
        url: await getSignedViewUrl(p.key),
      }))
    );
  }

  res.json(docs);
});

// ---------- PATCH: update stage only ----------
router.patch("/:id/stage", async (req, res) => {
  try {
    const { stage } = req.body;
    if (!stage) return res.status(400).json({ message: "stage required" });

    const doc = await Car.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Car not found" });

    let finalStage = String(stage).trim();
    const hasChecklist = doc.checklist && doc.checklist.length > 0;

    if (/^online$/i.test(finalStage) && hasChecklist) {
      finalStage = "In Works/Online";
    }

    doc.stage = finalStage;
    await doc.save();

    res.json({ message: "Stage updated", stage: doc.stage });
  } catch (err) {
    console.error("Stage patch error:", err);
    res.status(400).json({ message: "Error updating stage", error: err.message });
  }
});

// ---------- PATCH: update location only ----------
router.patch("/:id/location", async (req, res) => {
  try {
    const { location } = req.body;
    const doc = await Car.findById(req.params.id);

    if (!doc) return res.status(404).json({ message: "Car not found" });

    const newLoc = String(location || "").trim();
    const prevLoc = doc.location || "";

    if (newLoc !== prevLoc) {
      if (Array.isArray(doc.history) && doc.history.length) {
        const last = doc.history[doc.history.length - 1];
        if (last && !last.endDate) {
          last.endDate = new Date();
          last.days = daysClosed(last.startDate, last.endDate);
        }
      } else {
        doc.history = [];
      }

      if (newLoc) {
        doc.history.push({
          location: newLoc,
          startDate: new Date(),
          endDate: null,
          days: 0,
        });
      }

      doc.location = newLoc;
      doc.nextLocations = stripCurrentFromNext(
        doc.nextLocations,
        doc.location
      );
    }

    await doc.save();

    res.json({ message: "Location updated", location: doc.location });
  } catch (err) {
    console.error("Location patch error:", err);
    res.status(400).json({
      message: "Error updating location",
      error: err.message,
    });
  }
});


// ---------- PATCH: Update Next Locations ----------
router.patch("/:id/next", async (req, res) => {
  try {
    const { nextLocations } = req.body;

    const doc = await Car.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Car not found" });

    // clean array
    const cleaned = (nextLocations || [])
      .map((s) => String(s || "").trim())
      .filter(Boolean);

    doc.nextLocations = stripCurrentFromNext(cleaned, doc.location);

    await doc.save();

    res.json({
      message: "Next locations updated",
      nextLocations: doc.nextLocations,
    });
  } catch (err) {
    console.error("Next locations patch error:", err);
    res.status(400).json({
      message: "Error updating next locations",
      error: err.message,
    });
  }
});

// ---------- PATCH: Update Checklist & Auto-Recon ----------
router.patch("/:id/checklist", async (req, res) => {
  try {
    let { checklist } = req.body;

    if (!Array.isArray(checklist)) checklist = [];

    const doc = await Car.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Car not found" });

    // Normalise checklist text
    checklist = checklist.map((s) => String(s || "").trim()).filter(Boolean);

    doc.checklist = checklist;

    // Re-run recon inference
    let reconCreated = [];
    let categorized = [];

    try {
      const norm = normalizeChecklist(checklist);
      categorized = await decideCategoryForChecklist(
        doc.make,
        doc.model,
        norm
      );

      for (const c of categorized) {
        const result = await upsertReconFromChecklist(doc, c);
        if (result?.created) reconCreated.push(result.created);
      }
    } catch (err) {
      console.error("AI recon generation error:", err);
    }

    // Auto stage bump
    if (doc.stage === "Online" && checklist.length > 0) {
      doc.stage = "In Works/Online";
    }

    await doc.save();

    res.json({
      message: "Checklist updated",
      checklist: doc.checklist,
      recon: categorized,
      reconCreated,
      stage: doc.stage,
    });
  } catch (err) {
    console.error("Checklist patch error:", err);
    res.status(400).json({
      message: "Error updating checklist",
      error: err.message,
    });
  }
});

// ---------- PATCH: Update photos order + captions ----------
router.patch("/:id/photos", async (req, res) => {
  try {
    const id = req.params.id;
    let { photos } = req.body;

    if (!Array.isArray(photos)) photos = [];

    const doc = await Car.findById(id);
    if (!doc) return res.status(404).json({ message: "Car not found" });

    // Ensure correct structure
    const cleaned = photos.map((p) => ({
      key: String(p.key || "").trim(),
      caption: String(p.caption || "").trim(),
    }));

    doc.photos = cleaned;

    await doc.save();

    res.json({ message: "Photos updated", photos: doc.photos });
  } catch (err) {
    console.error("Photos patch error:", err);
    res.status(400).json({
      message: "Error updating photos",
      error: err.message,
    });
  }
});

// ----------------------------------------------------
// FINAL EXPORT
// ----------------------------------------------------
module.exports = router;








