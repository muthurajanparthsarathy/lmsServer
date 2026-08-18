const socketIO = require('socket.io');

let io;

module.exports = {
  init: (server) => {
    io = socketIO(server, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });
    
    io.on('connection', (socket) => {
      console.log('New client connected:', socket.id);
      
      // Join a specific live question room
      socket.on('join-live-question', (questionId) => {
        socket.join(`question-${questionId}`);
        console.log(`Socket ${socket.id} joined question-${questionId}`);
      });
      
      // Leave room
      socket.on('leave-live-question', (questionId) => {
        socket.leave(`question-${questionId}`);
      });
      
      socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
      });
    });
    
    return io;
  },
  getIO: () => {
    if (!io) {
      throw new Error('Socket.io not initialized');
    }
    return io;
  }
};