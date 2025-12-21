// models/CustomerAppointment.js
const mongoose = require('mongoose');

const CustomerAppointmentSchema = new mongoose.Schema(
  {
    name: { type: String, default: 'Customer' },

    dateTime: { type: String, default: '' },

    originalDateTime: { type: String, default: '' },

    isDelivery: { type: Boolean, default: false },

    // ✅ THIS IS THE MISSING PIECE
    isFollowUp: { type: Boolean, default: false },

    notes: { type: String, default: '' },

    car: { type: mongoose.Schema.Types.ObjectId, ref: 'Car', default: null },
    carText: { type: String, default: '' },

    dateCreated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  'CustomerAppointment',
  CustomerAppointmentSchema
);
