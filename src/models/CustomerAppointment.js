// models/CustomerAppointment.js
const mongoose = require('mongoose');

const CustomerAppointmentSchema = new mongoose.Schema(
  {
    name: { type: String, default: 'Customer' },

    // Primary free-text datetime used by the UI
    dateTime: { type: String, default: '' },

    // When moved to Delivery, we stash the original time here
    originalDateTime: { type: String, default: '' },

    // Flag that this row is in the Delivery table
    isDelivery: { type: Boolean, default: false },

    notes: { type: String, default: '' },

    car: { type: mongoose.Schema.Types.ObjectId, ref: 'Car', default: null },
    carText: { type: String, default: '' },

    dateCreated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CustomerAppointment', CustomerAppointmentSchema);
