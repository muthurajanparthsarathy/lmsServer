const config = require("config");
const JWT_TOKEN_KEY= config.get("JWT_TOKEN_KEY");
const jwt = require("jsonwebtoken");

module.exports.createSecretToken = (id) => {
  return jwt.sign({ id }, JWT_TOKEN_KEY, {
    expiresIn: 3 * 24 * 60 * 60,
  });
};