const express = require('express');
const router = express.Router();
const Task = require('../models/Task');

/**
 * Build a safe update object from request body (only fields we allow).
 * Supports linking a car by ObjectId OR using carText as a fallback label.
 */
function buildUpdate(body) {
  const out = {};

  // task (string)
  if (Object.prototype.hasOwnProperty.call(body, 'task')) {
    out.task = typeof body.task === 'string' ? body.task.trim() : body.task;
  }

  // car: allow ObjectId string; use null to clear
  if (Object.prototype.hasOwnProperty.call(body, 'car')) {
    out.car = body.car || null;
  }

  // carText: human-friendly fallback vehicle text (string)
  if (Object.prototype.hasOwnProperty.call(body, 'carText')) {
    out.carText = typeof body.carText === 'string' ? body.carText.trim() : body.carText;
  }

  // notes (string, may be empty)
  if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
    out.notes = typeof body.notes === 'string' ? body.notes.trim() : body.notes;
  }

  return out;
}

// GET all tasks
router.get('/', async (_req, res) => {
  try {
    const tasks = await Task.find().populate('car', 'rego make model').lean();
    res.json({ message: 'Tasks retrieved successfully', data: tasks });
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving tasks', error: error.message });
  }
});

// POST create task
router.post('/', async (req, res) => {
  try {
    // accept task, car, carText, notes
    const payload = buildUpdate(req.body);
    const doc = new Task(payload);
    await doc.save();
    const populated = await doc.populate('car', 'rego make model');
    res.status(201).json({ message: 'Task created successfully', data: populated });
  } catch (error) {
    res.status(400).json({ message: 'Error creating task', error: error.message });
  }
});

// PUT update task (read → modify → save, then repopulate)
router.put('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const allowed = buildUpdate(req.body);

    const doc = await Task.findById(id);
    if (!doc) return res.status(404).json({ message: 'Task not found' });

    // Snapshot before
    const before = {
      task: doc.task ?? '',
      car: doc.car ? String(doc.car) : '',
      carText: doc.carText ?? '',
      notes: doc.notes ?? '',
    };

    // Apply allowed fields only
    if (Object.prototype.hasOwnProperty.call(allowed, 'task')) doc.task = allowed.task;
    if (Object.prototype.hasOwnProperty.call(allowed, 'car')) doc.car = allowed.car; // may be null to clear
    if (Object.prototype.hasOwnProperty.call(allowed, 'carText')) doc.carText = allowed.carText;
    if (Object.prototype.hasOwnProperty.call(allowed, 'notes')) doc.notes = allowed.notes;

    // Diff
    const after = {
      task: doc.task ?? '',
      car: doc.car ? String(doc.car) : '',
      carText: doc.carText ?? '',
      notes: doc.notes ?? '',
    };
    const changed = Object.keys(after).some(k => String(before[k] ?? '') !== String(after[k] ?? ''));

    if (!changed) {
      const unchanged = await doc.populate('car', 'rego make model');
      return res.json({ message: 'No changes detected', data: unchanged });
    }

    await doc.save();
    const populated = await doc.populate('car', 'rego make model');
    res.json({ message: 'Task updated successfully', data: populated });
  } catch (error) {
    console.error('Update error:', error);
    res.status(400).json({ message: 'Error updating task', error: error.message });
  }
});

// DELETE task
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Task.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Task not found' });
    res.json({ message: 'Task deleted successfully', data: deleted });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting task', error: error.message });
  }
});

module.exports = router;
