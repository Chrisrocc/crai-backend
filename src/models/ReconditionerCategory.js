const mongoose = require('mongoose');

const reconditionerCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Category name is required'], trim: true, unique: true },
    keywords: { type: [String], default: [] },
    rules: { type: [String], default: [] },
    defaultService: { type: String, default: '', trim: true },

    // already added earlier
    onPremises: { type: Boolean, default: true },

    // NEW: controls display ordering
    sortOrder: { type: Number, default: 0, index: true },
  },
  { timestamps: true }
);

reconditionerCategorySchema.index({ name: 1 }, { unique: true });

module.exports = mongoose.model('ReconditionerCategory', reconditionerCategorySchema);
