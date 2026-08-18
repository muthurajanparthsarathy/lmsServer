// routes/authMiddleware.js
const User = require("../models/UserModel");
const config = require("config");
const JWT_TOKEN_KEY = config.get("JWT_TOKEN_KEY");
const jwt = require("jsonwebtoken");
const tokenModal = require("../models/tokenModal");

const userAuth = async (req, res, next) => {
  const bearerHeader = req.headers["authorization"];
  let token = "";
  
  if (bearerHeader) {
    const bearer = bearerHeader.split(" ");
    const bearerToken = bearer[1];
    token = bearerToken;
    req.token = bearerToken;
  }
  
  if (!token) {
    return res.status(401).json({ 
      message: [{ key: 'error', value: 'User is not logged in' }] 
    });
  }

  try {
    // First check if token exists in Token schema
    const tokenDoc = await tokenModal.findOne({ token: token });
    
    if (!tokenDoc) {
      res.clearCookie("token");
      return res.status(401).json({ 
        message: [{ key: 'error', value: 'Invalid or expired token' }] 
      });
    }

    // Verify JWT token
    jwt.verify(token, JWT_TOKEN_KEY, async (err, data) => {
      if (err) {
        console.log('JWT verification error:', err);
        // Remove invalid token from database
        await tokenModal.deleteOne({ token: token });
        res.clearCookie("token");
        return res.status(401).json({ 
          message: [{ key: 'error', value: 'Invalid token' }] 
        });
      } else {
        // Find user by ID from JWT payload
        const user = await User.findById(data.id);
        
        if (user) {
          req.user = user;
          next();
        } else {
          console.log("User not found in database");
          // Remove token for non-existent user
          await tokenModal.deleteOne({ token: token });
          res.clearCookie("token");
          return res.status(401).json({ 
            message: [{ key: 'error', value: 'User not found' }] 
          });
        }
      }
    });
    
  } catch (error) {
    console.error('Error in userAuth middleware:', error);
    return res.status(500).json({ 
      message: [{ key: 'error', value: 'Internal server error' }] 
    });
  }
};

module.exports = userAuth;