const express = require('express')
const router = express.Router()
const { convertPptToImages } = require('../../controllers/courses/pptConversionController')

// POST /api/ppt/convert
// Body: { pptUrl: "https://cloudinary.com/..." }
// Returns: { success: true, slideImages: [...], totalSlides: N }
router.post('/api/ppt/convert', convertPptToImages)

module.exports = router
