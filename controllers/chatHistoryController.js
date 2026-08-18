const User = require("../models/UserModel");

// Get all chat sessions for a user
exports.getChatSessions = async (req, res) => {
  try {
    const userId = req.user._id;
    
    const user = await User.findById(userId, { 
      'ai_history': 1,
      'firstName': 1,
      'email': 1 
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Sort by lastMessageAt descending
    const sortedSessions = user.ai_history.sort((a, b) => 
      new Date(b.lastMessageAt) - new Date(a.lastMessageAt)
    );

    return res.status(200).json({
      success: true,
      sessions: sortedSessions,
      total: sortedSessions.length
    });
  } catch (error) {
    console.error("Error fetching chat sessions:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Get specific chat session by ID
exports.getChatSession = async (req, res) => {
  try {
    const userId = req.user._id;
    const { sessionId } = req.params;

    const user = await User.findOne(
      { 
        _id: userId,
        'ai_history.sessionId': sessionId 
      },
      { 
        'ai_history.$': 1 
      }
    );

    if (!user || !user.ai_history || user.ai_history.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Chat session not found"
      });
    }

    return res.status(200).json({
      success: true,
      session: user.ai_history[0]
    });
  } catch (error) {
    console.error("Error fetching chat session:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Create new chat session
exports.createChatSession = async (req, res) => {
  try {
    const userId = req.user._id;
    const { title, context, initialMessage } = req.body;

    const newSession = {
      sessionId: `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title: title || "New Chat",
      messages: [],
      context: context || {},
      lastMessageAt: new Date(),
      messageCount: 0,
      isArchived: false
    };

    // Add initial welcome message
    if (initialMessage === undefined || initialMessage === true) {
      newSession.messages.push({
        content: "Hello! I'm your AI assistant powered by SmartCliff. I'm here to help you with anything you need - whether it's answering questions, having a conversation, brainstorming ideas, or helping with tasks. What would you like to chat about? ✨",
        role: "assistant",
        timestamp: new Date(),
        metadata: context || {}
      });
      newSession.messageCount = 1;
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { 
        $push: { 
          ai_history: newSession 
        } 
      },
      { 
        new: true,
        projection: { 'ai_history': { $slice: -1 } }
      }
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const createdSession = user.ai_history[user.ai_history.length - 1];

    return res.status(201).json({
      success: true,
      message: "Chat session created successfully",
      session: createdSession
    });
  } catch (error) {
    console.error("Error creating chat session:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Add message to existing chat session
exports.addMessage = async (req, res) => {
  try {
    const userId = req.user._id;
    const { sessionId } = req.params;
    const { content, role, metadata } = req.body;

    if (!content || !role || !["user", "assistant"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Valid content and role (user/assistant) are required"
      });
    }

    const newMessage = {
      content,
      role,
      timestamp: new Date(),
      metadata: metadata || {}
    };

    // Find the session and update it - FIXED VERSION
    const user = await User.findOneAndUpdate(
      { 
        _id: userId,
        'ai_history.sessionId': sessionId 
      },
      { 
        $push: { 
          'ai_history.$.messages': newMessage 
        },
        $set: { 
          'ai_history.$.lastMessageAt': new Date()
        },
        $inc: { 
          'ai_history.$.messageCount': 1
        }
      },
      { 
        new: true
      }
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Chat session not found"
      });
    }

    // Also update title if it's the first user message
    const session = user.ai_history.find(s => s.sessionId === sessionId);
    if (session && session.messageCount === 2) {
      // Check if there's a user message (should be message at index 1 if we just added it)
      const hasUserMessage = session.messages.some(m => m.role === "user");
      
      if (hasUserMessage && session.messages[0]?.role === "assistant") {
        // Update title based on first user message
        const firstUserMessage = session.messages.find(m => m.role === "user");
        if (firstUserMessage) {
          const title = firstUserMessage.content.substring(0, 50);
          const updatedTitle = title.length < firstUserMessage.content.length ? title + "..." : title;
          
          await User.updateOne(
            { 
              _id: userId,
              'ai_history.sessionId': sessionId 
            },
            { 
              $set: { 
                'ai_history.$.title': updatedTitle 
              } 
            }
          );
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: "Message added successfully",
      addedMessage: newMessage
    });
  } catch (error) {
    console.error("Error adding message:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Update chat session title
exports.updateSessionTitle = async (req, res) => {
  try {
    const userId = req.user._id;
    const { sessionId } = req.params;
    const { title } = req.body;

    if (!title || title.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Title is required"
      });
    }

    const updatedUser = await User.findOneAndUpdate(
      { 
        _id: userId,
        'ai_history.sessionId': sessionId 
      },
      { 
        $set: { 
          'ai_history.$.title': title.trim() 
        } 
      },
      { 
        new: true 
      }
    );

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        message: "Chat session not found"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Session title updated successfully"
    });
  } catch (error) {
    console.error("Error updating session title:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Delete chat session
exports.deleteChatSession = async (req, res) => {
  try {
    const userId = req.user._id;
    const { sessionId } = req.params;

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { 
        $pull: { 
          ai_history: { sessionId: sessionId } 
        } 
      },
      { 
        new: true 
      }
    );

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Check if session was removed
    const sessionExists = updatedUser.ai_history.some(s => s.sessionId === sessionId);
    if (sessionExists) {
      return res.status(404).json({
        success: false,
        message: "Chat session not found"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Chat session deleted successfully"
    });
  } catch (error) {
    console.error("Error deleting chat session:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Clear all chat sessions
exports.clearAllSessions = async (req, res) => {
  try {
    const userId = req.user._id;

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { 
        $set: { 
          ai_history: [] 
        } 
      },
      { 
        new: true 
      }
    );

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    return res.status(200).json({
      success: true,
      message: "All chat sessions cleared successfully"
    });
  } catch (error) {
    console.error("Error clearing chat sessions:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};

// Archive/Unarchive chat session
exports.toggleArchiveSession = async (req, res) => {
  try {
    const userId = req.user._id;
    const { sessionId } = req.params;
    const { isArchived } = req.body;

    const updatedUser = await User.findOneAndUpdate(
      { 
        _id: userId,
        'ai_history.sessionId': sessionId 
      },
      { 
        $set: { 
          'ai_history.$.isArchived': isArchived !== undefined ? isArchived : true 
        } 
      },
      { 
        new: true 
      }
    );

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        message: "Chat session not found"
      });
    }

    return res.status(200).json({
      success: true,
      message: `Session ${isArchived !== false ? 'archived' : 'unarchived'} successfully`
    });
  } catch (error) {
    console.error("Error archiving session:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};