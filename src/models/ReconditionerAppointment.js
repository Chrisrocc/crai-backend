// src/models/ReconditionerAppointment.js
const mongoose = require('mongoose');

const CarEntrySchema = new mongoose.Schema(
  {
    // If identified, we store a ref:
    car: { type: mongoose.Schema.Types.ObjectId, ref: 'Car', default: null },
    // If not identified, we still store whatever we know:
    carText: { type: String, trim: true, default: '' },
    // Per-car notes
    notes: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const reconditionerAppointmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Name is required'], trim: true },
    // ❗ Make dateTime optional
    dateTime: { type: String, default: '', trim: true },
    cars: { type: [CarEntrySchema], default: [] }, // always push at least one entry
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'ReconditionerCategory', required: true },
    dateCreated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReconditionerAppointment', reconditionerAppointmentSchema);
