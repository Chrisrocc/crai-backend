const mongoose = require('mongoose');

const HistorySchema = new mongoose.Schema(
  {
    location: { type: String, trim: true },
    startDate: { type: Date, default: Date.now },
    endDate: { type: Date, default: null },
    days: { type: Number, default: 0 },
  },
  { _id: false }
);

const PhotoSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    caption: { type: String, trim: true, default: '' },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const CarSchema = new mongoose.Schema(
  {
    rego: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      // Enforce A–Z0–9 only
      set: (v) => (v ?? '').toString().toUpperCase().replace(/[^A-Z0-9]/g, ''),
      validate: {
        validator: (v) => /^[A-Z0-9]+$/.test(v),
        message: 'Rego must be letters and numbers only.',
      },
    },
    make: { type: String, trim: true },
    model: { type: String, trim: true },
    badge: { type: String, trim: true },
    series: { type: String, trim: true },
    year: { type: Number },
    description: { type: String, trim: true },

    checklist: { type: [String], default: [] },

    // current/actual location + history
    location: { type: String, trim: true },
    history: { type: [HistorySchema], default: [] },

    // list of next locations
    nextLocations: { type: [String], default: [] },

    // photos (S3 keys only)
    photos: { type: [PhotoSchema], default: [] },

    readinessStatus: { type: String, trim: true },
    stage: { type: String, trim: true }, // 'In Works', 'Online', 'Sold'
    notes: { type: String, trim: true },

    dateCreated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Virtual: last nextLocation
CarSchema.virtual('nextLocation').get(function () {
  if (!Array.isArray(this.nextLocations) || this.nextLocations.length === 0) return '';
  return this.nextLocations[this.nextLocations.length - 1] || '';
});

CarSchema.set('toJSON', { virtuals: true });
CarSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Car', CarSchema);
