const validatePage = (req, res, next) => {
  const { pages } = req.body

  // 1. Deduplicate page IDs
  if (Array.isArray(pages)) {
    const seen = new Set()
    for (const p of pages) {
      if (!p.id) p.id = require("mongoose").Types.ObjectId().toString()
      if (seen.has(p.id)) {
        return res.status(400).json({
          message: [{ key: "error", value: `Duplicate page ID: ${p.id}` }]
        })
      }
      seen.add(p.id)
      if (!Array.isArray(p.blocks)) p.blocks = []
    }
  }

  // 2. Sanitize block content — strip <script> from non-playground blocks
  const sanitizeBlocks = (blocks = []) =>
    blocks.map(b => {
      if (b.type === "code_playground") return b // sandboxed, safe
      if (typeof b.content === "string") {
        b.content = b.content.replace(/<script[\s\S]*?<\/script>/gi, "")
      }
      return b
    })

  if (Array.isArray(req.body.pages)) {
    req.body.pages = req.body.pages.map(p => ({
      ...p, blocks: sanitizeBlocks(p.blocks),
    }))
  }
  if (Array.isArray(req.body.blocks)) {
    req.body.blocks = sanitizeBlocks(req.body.blocks)
  }

  next()
}

module.exports = { validatePage }