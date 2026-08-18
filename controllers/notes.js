
const User = require("../models/UserModel");

const mongoose = require("mongoose");

const generateNoteId = () => new mongoose.Types.ObjectId();

// Create a new note for user
exports.createNote = async (req, res) => {
  try {
    const { title, content, tags, isPinned, color, resourceId, resourceType, anchor } = req.body;

    const newNote = {
      _id: generateNoteId(),
      title: title || "Untitled Note",
      content: content || "",
      tags: tags || [],

      isPinned: isPinned || false,
      color: color || "#ffffff",
      lastEdited: new Date()
    };

    if (resourceId) newNote.resourceId = resourceId;
    if (resourceType && ['pdf', 'ppt', 'video'].includes(resourceType)) newNote.resourceType = resourceType;
    if (anchor && (anchor.page != null || anchor.timestamp != null)) {
      newNote.anchor = {};
      if (anchor.page != null) newNote.anchor.page = Number(anchor.page);
      if (anchor.timestamp != null) newNote.anchor.timestamp = Number(anchor.timestamp);
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $push: { notes: newNote } },
      { new: true, runValidators: true }
    ).select('notes');

    const createdNote = user.notes[user.notes.length - 1];

    res.status(201).json({
      success: true,
      message: "Note created successfully",
      data: createdNote
    });
  } catch (error) {
    console.error("Create note error:", error);
    res.status(500).json({
      success: false,
      message: "Error creating note",
      error: error.message
    });
  }
};

// Get all notes for a user
exports.getUserNotes = async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 50, 
      search, 
      tags, 
      isPinned,
      sortBy = 'lastEdited',
      sortOrder = 'desc'
    } = req.query;

    const user = await User.findById(req.user._id).select('notes');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    let notes = user.notes;

    // Apply filters
    if (search) {
      notes = notes.filter(note => 
        note.title.toLowerCase().includes(search.toLowerCase()) ||
        note.content.toLowerCase().includes(search.toLowerCase())
      );
    }

    if (tags) {
      const tagArray = Array.isArray(tags) ? tags : [tags];
      notes = notes.filter(note => 
        note.tags.some(tag => tagArray.includes(tag))
      );
    }

   

    if (isPinned !== undefined) {
      const pinned = isPinned === 'true';
      notes = notes.filter(note => note.isPinned === pinned);
    }

    // Apply sorting
    notes.sort((a, b) => {
      if (sortBy === 'lastEdited') {
        return sortOrder === 'asc' 
          ? new Date(a.lastEdited) - new Date(b.lastEdited)
          : new Date(b.lastEdited) - new Date(a.lastEdited);
      }
      if (sortBy === 'title') {
        return sortOrder === 'asc'
          ? a.title.localeCompare(b.title)
          : b.title.localeCompare(a.title);
      }
      return 0;
    });

    // Apply pagination
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + parseInt(limit);
    const paginatedNotes = notes.slice(startIndex, endIndex);

    res.status(200).json({
      success: true,
      data: paginatedNotes,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(notes.length / limit),
        totalNotes: notes.length,
        hasNext: endIndex < notes.length,
        hasPrev: startIndex > 0
      }
    });
  } catch (error) {
    console.error("Get user notes error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching notes",
      error: error.message
    });
  }
};

// Get note by ID
exports.getNoteById = async (req, res) => {
  try {
    const user = await User.findOne(
      { _id: req.user._id },
      { notes: { $elemMatch: { _id: req.params.id } } }
    );

    if (!user || !user.notes.length) {
      return res.status(404).json({
        success: false,
        message: "Note not found"
      });
    }

    res.status(200).json({
      success: true,
      data: user.notes[0]
    });
  } catch (error) {
    console.error("Get note by ID error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching note",
      error: error.message
    });
  }
};

// Update note
exports.updateNote = async (req, res) => {
  try {
    const { title, content, tags, isPinned, color, resourceId, resourceType, anchor } = req.body;

    const updateFields = {};
    if (title !== undefined) updateFields["notes.$.title"] = title;
    if (content !== undefined) updateFields["notes.$.content"] = content;
    if (tags !== undefined) updateFields["notes.$.tags"] = tags;
    if (isPinned !== undefined) updateFields["notes.$.isPinned"] = isPinned;
    if (color !== undefined) updateFields["notes.$.color"] = color;
    if (resourceId !== undefined) updateFields["notes.$.resourceId"] = resourceId;
    if (resourceType !== undefined && ['pdf', 'ppt', 'video'].includes(resourceType)) {
      updateFields["notes.$.resourceType"] = resourceType;
    }
    if (anchor !== undefined) {
      const cleaned = {};
      if (anchor && anchor.page != null) cleaned.page = Number(anchor.page);
      if (anchor && anchor.timestamp != null) cleaned.timestamp = Number(anchor.timestamp);
      updateFields["notes.$.anchor"] = cleaned;
    }
    updateFields["notes.$.lastEdited"] = new Date();

    const user = await User.findOneAndUpdate(
      { 
        _id: req.user._id,
        "notes._id": req.params.id 
      },
      { $set: updateFields },
      { new: true, runValidators: true }
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Note not found"
      });
    }

    const updatedNote = user.notes.find(note => note._id.toString() === req.params.id);

    res.status(200).json({
      success: true,
      message: "Note updated successfully",
      data: updatedNote
    });
  } catch (error) {
    console.error("Update note error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating note",
      error: error.message
    });
  }
};

// Delete note
exports.deleteNote = async (req, res) => {
  try {
    const pathIds = req.params[0] || '';
    
    const noteIds = pathIds.replace(/^\//, '').split('/').filter(id => id);


    if (noteIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Note IDs are required"
      });
    }

    // Validate all IDs
    const invalidIds = noteIds.filter(id => !mongoose.Types.ObjectId.isValid(id));
    if (invalidIds.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid note ID format",
        invalidIds
      });
    }

    // Convert to ObjectId
    const objectIds = noteIds.map(id => new mongoose.Types.ObjectId(id));

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $pull: { notes: { _id: { $in: objectIds } } } },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    res.status(200).json({
      success: true,
      message: "Notes deleted successfully",
      deletedCount: noteIds.length,
      deletedIds: noteIds
    });
  } catch (error) {
    console.error("Delete notes error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting notes",
      error: error.message
    });
  }
};


// Get notes for a specific resource (PDF / PPT / Video) for the current user
exports.getNotesByResource = async (req, res) => {
  try {
    const { resourceId } = req.params;
    const { type } = req.query;

    if (!resourceId) {
      return res.status(400).json({ success: false, message: "resourceId is required" });
    }

    const user = await User.findById(req.user._id).select('notes');
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    let notes = user.notes.filter(n => n.resourceId === resourceId);
    if (type && ['pdf', 'ppt', 'video'].includes(type)) {
      notes = notes.filter(n => n.resourceType === type);
    }

    notes.sort((a, b) => {
      const av = (a.anchor && (a.anchor.page ?? a.anchor.timestamp)) ?? 0;
      const bv = (b.anchor && (b.anchor.page ?? b.anchor.timestamp)) ?? 0;
      return av - bv;
    });

    res.status(200).json({ success: true, data: notes });
  } catch (error) {
    console.error("Get notes by resource error:", error);
    res.status(500).json({ success: false, message: "Error fetching resource notes", error: error.message });
  }
};

exports.togglePinNote = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const noteIndex = user.notes.findIndex(n => n._id.toString() === req.params.id);
    
    if (noteIndex === -1) {
      return res.status(404).json({ success: false, message: "Note not found" });
    }

    // Toggle the pin status
    user.notes[noteIndex].isPinned = !user.notes[noteIndex].isPinned;
    user.notes[noteIndex].lastEdited = new Date();

    await user.save();

    res.status(200).json({
      success: true,
      message: `Note ${user.notes[noteIndex].isPinned ? 'pinned' : 'unpinned'} successfully`,
      data: user.notes[noteIndex]
    });
  } catch (error) {
    console.error("Toggle pin note error:", error);
    res.status(500).json({
      success: false,
      message: "Error toggling pin status",
      error: error.message
    });
  }
};