const { GoogleGenAI } = require("@google/genai");

// Initialize Gemini AI using GoogleGenAI (as in gemini.js)
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// Configure the model
const modelName = "gemini-2.5-flash-lite"; // Using gemini-2.5-flash as in your gemini.js

// Chat history storage in memory (you can use Redis for production)
const chatHistories = new Map();

// Helper function to format conversation history
const formatHistory = (messages) => {
  return messages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.content }]
  }));
};

// Generate AI response with Gemini
exports.generateAIResponse = async (req, res) => {
  try {
    const { 
      message, 
      conversationHistory = [], 
      context,
      sessionId = 'default'
    } = req.body;

    const userId = req.user?._id;

    if (!message || message.trim() === '') {
      return res.status(400).json({
        success: false,
        error: "Message is required"
      });
    }

    // Prepare conversation history
    let history = conversationHistory;
    
    // If we have a session ID, try to get stored history
    if (userId && sessionId) {
      const sessionKey = `${userId}_${sessionId}`;
      if (chatHistories.has(sessionKey)) {
        history = chatHistories.get(sessionKey);
      }
    }

    // Add context to the message if provided
    let fullMessage = message;
    if (context) {
      if (context.topicTitle) {
        fullMessage = `Context: Learning about "${context.topicTitle}". ${message}`;
      }
      if (context.fileName) {
        fullMessage = `Regarding file: ${context.fileName}. ${fullMessage}`;
      }
    }

    try {
      // Generate response using the same pattern as gemini.js
      let result;
      
      if (history.length > 0) {
        // For conversation with history
        const contents = [
          ...history.map(msg => ({
            role: msg.role,
            parts: [{ text: msg.content }]
          })),
          {
            role: 'user',
            parts: [{ text: fullMessage }]
          }
        ];
        
        result = await ai.models.generateContent({
          model: modelName,
          contents: contents
        });
      } else {
        // For single message without history
        result = await ai.models.generateContent({
          model: modelName,
          contents: fullMessage
        });
      }

      const aiResponse = result.text();
      
      // Update conversation history
      const updatedHistory = [
        ...history,
        { role: 'user', content: fullMessage },
        { role: 'model', content: aiResponse }
      ];

      // Store history if we have userId and sessionId
      if (userId && sessionId) {
        const sessionKey = `${userId}_${sessionId}`;
        chatHistories.set(sessionKey, updatedHistory);
      }

      // Save to database if we have user (optional)
      if (userId && sessionId) {
        try {
          const User = require("../models/UserModel");
          await User.findByIdAndUpdate(
            userId,
            {
              $push: {
                'ai_history': {
                  sessionId: sessionId,
                  title: message.substring(0, 50) + (message.length > 50 ? '...' : ''),
                  messages: [
                    { content: fullMessage, role: 'user', timestamp: new Date() },
                    { content: aiResponse, role: 'assistant', timestamp: new Date() }
                  ],
                  lastMessageAt: new Date(),
                  messageCount: 2
                }
              }
            },
            { new: true }
          );
        } catch (dbError) {
          console.error("Error saving to database:", dbError);
          // Continue even if DB save fails
        }
      }

      return res.status(200).json({
        success: true,
        response: aiResponse,
        sessionId: sessionId,
        historyLength: updatedHistory.length
      });

    } catch (geminiError) {
      console.error("Gemini API Error:", geminiError);
      
      // Provide a fallback response
      const fallbackResponse = `I understand you're asking about "${message.substring(0, 50)}...". ` +
        `This is an interesting topic! As an AI assistant, I'd normally provide a detailed response, ` +
        `but there seems to be a temporary issue. Please try again in a moment.`;

      return res.status(200).json({
        success: false,
        response: fallbackResponse,
        error: "Gemini API unavailable, using fallback",
        sessionId: sessionId
      });
    }

  } catch (error) {
    console.error("Error in generateAIResponse:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
      message: error.message
    });
  }
};

// Clear chat history
exports.clearChatHistory = async (req, res) => {
  try {
    const { sessionId = 'default' } = req.body;
    const userId = req.user?._id;

    if (userId && sessionId) {
      const sessionKey = `${userId}_${sessionId}`;
      chatHistories.delete(sessionKey);
    }

    return res.status(200).json({
      success: true,
      message: "Chat history cleared"
    });
  } catch (error) {
    console.error("Error clearing chat history:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
};

// Get chat sessions
exports.getChatSessions = async (req, res) => {
  try {
    const userId = req.user._id;
    const User = require("../models/UserModel");

    const user = await User.findById(userId, { 'ai_history': 1 });
    
    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found"
      });
    }

    // Sort sessions by lastMessageAt
    const sortedSessions = user.ai_history.sort((a, b) => 
      new Date(b.lastMessageAt) - new Date(a.lastMessageAt)
    );

    return res.status(200).json({
      success: true,
      sessions: sortedSessions,
      total: sortedSessions.length
    });
  } catch (error) {
    console.error("Error getting chat sessions:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
};

console.log("Gemini routes initialized with API key");