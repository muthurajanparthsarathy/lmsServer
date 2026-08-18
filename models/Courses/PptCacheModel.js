const mongoose = require('mongoose')

const pptCacheSchema = new mongoose.Schema({
  pptUrl: { type: String, required: true, unique: true, index: true },
  slideImages: [{ type: String }],
  totalSlides: { type: Number },
  createdAt: { type: Date, default: Date.now },
})

module.exports = mongoose.model('PptCache', pptCacheSchema)
