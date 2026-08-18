// middleware/validateQueryParams.js
/**
 * Middleware to reject all query parameters
 * Use this for endpoints that should not accept any query parameters
 */
const rejectAllQueryParams = (req, res, next) => {
  if (Object.keys(req.query).length > 0) {
    return res.status(400).json({
      success: false,
      message: [
        {
          key: "error",
          value: "Query parameters are not supported for this endpoint"
        }
      ],
    });
  }
  next();
};
 
/**
 * Middleware to allow only specific query parameters
 * @param {string[]} allowedParams - Array of allowed parameter names
 */
const allowOnlyQueryParams = (allowedParams = []) => {
  return (req, res, next) => {
    const queryKeys = Object.keys(req.query);
   
    if (queryKeys.length === 0) {
      return next();
    }
   
    const invalidParams = queryKeys.filter(key => !allowedParams.includes(key));
   
    if (invalidParams.length > 0) {
      return res.status(400).json({
        success: false,
        message: [
          {
            key: "error",
            value: `Invalid query parameters: ${invalidParams.join(', ')}. Allowed parameters: ${allowedParams.join(', ')}`
          }
        ],
      });
    }
    next();
  };
};
 
module.exports = {
  rejectAllQueryParams,
  allowOnlyQueryParams
};
 