const express = require("express");
const router = express.Router();
const chatHistoryController = require("../controllers/chatHistoryController");

// Import the middleware from the correct file
const userAuth = require("./authMiddleware");  // or "../middleware/userAuth" if you put it elsewhere

// All routes require authentication
router.use(userAuth);

// Chat session routes
router.get("/sessions", chatHistoryController.getChatSessions);
router.get("/sessions/:sessionId", chatHistoryController.getChatSession);
router.post("/sessions", chatHistoryController.createChatSession);
router.put("/sessions/:sessionId/title", chatHistoryController.updateSessionTitle);
router.delete("/sessions/:sessionId", chatHistoryController.deleteChatSession);
router.delete("/sessions", chatHistoryController.clearAllSessions);
router.put("/sessions/:sessionId/archive", chatHistoryController.toggleArchiveSession);
router.post("/sessions/:sessionId/messages", chatHistoryController.addMessage);

module.exports = router;