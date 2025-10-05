const express = require('express');
const router = express.Router();
const ReconditionerCategory = require('../models/ReconditionerCategory');
const ReconditionerAppointment = require('../models/ReconditionerAppointment');

function normalizeStrArray(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map((s) => String(s || '').trim()).filter(Boolean);
  return String(input).split(',').map((s) => s.trim()).filter(Boolean);
}

// GET all (sorted)
router.get('/', async (_req, res) => {
  try {
    const categories = await ReconditionerCategory.find().sort({ sortOrder: 1, name: 1 }).lean();
    res.json({ message: 'Categories retrieved successfully', data: categories });
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving categories', error: error.message });
  }
});

// Create (auto place at end)
router.post('/', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Category name is required' });

    const keywords = normalizeStrArray(req.body?.keywords);
    const rules = normalizeStrArray(req.body?.rules);
    const defaultService = String(req.body?.defaultService || '').trim();
    const onPremises = Boolean(req.body?.onPremises);

    const last = await ReconditionerCategory.findOne().sort({ sortOrder: -1 }).lean();
    const sortOrder = (last?.sortOrder || 0) + 1;

    const cat = new ReconditionerCategory({ name, keywords, rules, defaultService, onPremises, sortOrder });
    await cat.save();
    res.status(201).json({ message: 'Category created successfully', data: cat });
  } catch (error) {
    res.status(400).json({ message: 'Error creating category', error: error.message });
  }
});

// Update fields
router.put('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const patch = {};

    if ('name' in req.body) {
      patch.name = String(req.body.name || '').trim();
      if (!patch.name) return res.status(400).json({ message: 'Category name is required' });
    }
    if ('keywords' in req.body) patch.keywords = normalizeStrArray(req.body.keywords);
    if ('rules' in req.body) patch.rules = normalizeStrArray(req.body.rules);
    if ('defaultService' in req.body) patch.defaultService = String(req.body.defaultService || '').trim();
    if ('onPremises' in req.body) patch.onPremises = Boolean(req.body.onPremises);
    if ('sortOrder' in req.body) patch.sortOrder = Number(req.body.sortOrder) || 0; // rarely needed directly

    const updated = await ReconditionerCategory.findByIdAndUpdate(id, patch, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ message: 'Category not found' });
    res.json({ message: 'Category updated successfully', data: updated });
  } catch (error) {
    res.status(400).json({ message: 'Error updating category', error: error.message });
  }
});

// NEW: bulk reorder
// body: { ids: ["5f...","5f...","..."] } in desired order (top -> bottom)
router.put('/reorder/all', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ message: 'ids array required' });

    const ops = ids.map((id, i) => ({
      updateOne: { filter: { _id: id }, update: { $set: { sortOrder: i + 1 } } }
    }));
    await ReconditionerCategory.bulkWrite(ops);

    const data = await ReconditionerCategory.find().sort({ sortOrder: 1, name: 1 }).lean();
    res.json({ message: 'Reordered successfully', data });
  } catch (error) {
    res.status(400).json({ message: 'Error reordering categories', error: error.message });
  }
});

// Delete category + its appointments
router.delete('/:id', async (req, res) => {
  try {
    const categoryId = req.params.id;
    await ReconditionerAppointment.deleteMany({ category: categoryId });
    const cat = await ReconditionerCategory.findByIdAndDelete(categoryId);
    if (!cat) return res.status(404).json({ message: 'Category not found' });
    res.json({ message: 'Category and appointments deleted successfully', data: cat });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting category', error: error.message });
  }
});

module.exports = router;
