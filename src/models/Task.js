const mongoose = require('mongoose');

const TaskSchema = new mongoose.Schema(
  {
    task: { type: String, required: true },          // The “Prompt 2” refined line
    car: { type: mongoose.Schema.Types.ObjectId, ref: 'Car', default: null },
    carText: { type: String, default: '' },          // Fallback vehicle string when car isn’t identified
    notes: { type: String, default: '' },            // Optional extra notes/context
    dateCreated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Task', TaskSchema);
