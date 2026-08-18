const express = require('express');
const { createNote, getUserNotes, getNoteById, updateNote, deleteNote, togglePinNote, getNotesByResource } = require('../controllers/notes');
const { userAuth } = require('../middlewares/userAuth');
const router = express.Router()

router.post("/create/notes",userAuth, createNote);
router.get("/getAll/notes",userAuth, getUserNotes);
router.get("/notes/byResource/:resourceId", userAuth, getNotesByResource);
router.get("/getById/notes/:id",userAuth,  getNoteById);
router.put("/update/notes/:id",userAuth,  updateNote);
router.delete("/delete/notes/ById/*", userAuth, deleteNote);
router.put("/toggle-pin/notes/:id",userAuth, togglePinNote);

module.exports = router
