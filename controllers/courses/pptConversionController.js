const path = require('path')
const fs = require('fs-extra')
const axios = require('axios')
const cloudinary = require('cloudinary').v2
const { execFile } = require('child_process')
const { promisify } = require('util')
const os = require('os')
const PptCache = require('../../models/Courses/PptCacheModel')

const execFileAsync = promisify(execFile)

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
})

const SOFFICE = 'C:/Program Files/LibreOffice/program/soffice.exe'

// In-flight conversions keyed by cacheKey — prevents duplicate LibreOffice runs
// and duplicate Cloudinary uploads when the same deck is requested concurrently.
const inFlightConversions = new Map()

// Core pipeline: buffer → LibreOffice PDF → page images → Cloudinary → PptCache.
// Returns { slideImages, totalSlides }. Reusable from the route handler and from
// background upload-time conversion (pedagogyView.js).
async function convertDocumentToSlides({ buffer, ext, cacheKey }) {
  if (cacheKey && inFlightConversions.has(cacheKey)) {
    console.log('⏳ Conversion already in flight — joining existing run')
    return inFlightConversions.get(cacheKey)
  }

  const promise = performConversion({ buffer, ext, cacheKey })

  if (cacheKey) {
    inFlightConversions.set(cacheKey, promise)
    promise.catch(() => {}).finally(() => inFlightConversions.delete(cacheKey))
  }

  return promise
}

async function performConversion({ buffer, ext, cacheKey }) {
  const tempDir = path.join(os.tmpdir(), `ppt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)

  try {
    await fs.ensureDir(tempDir)

    const inputPath = path.join(tempDir, `presentation.${ext}`)
    await fs.writeFile(inputPath, buffer)

    // 2. Document → PDF via LibreOffice (works for pptx, docx, doc, ppt, odp, odt, etc.)
    console.log('📄 Converting to PDF via LibreOffice...')
    await execFileAsync(
      SOFFICE,
      ['--headless', '--convert-to', 'pdf', '--outdir', tempDir, inputPath],
      { timeout: 120000 }
    )

    // LibreOffice names the PDF after the input file stem (presentation.{ext} → presentation.pdf)
    const pdfPath = path.join(tempDir, 'presentation.pdf')
    if (!await fs.pathExists(pdfPath)) {
      throw new Error('LibreOffice PDF conversion failed')
    }

    // 3. PDF pages → PNG images via pdf-to-img
    console.log('🖼️  Rendering slides...')
    const { pdf } = await import('pdf-to-img')
    const pdfBuffer = await fs.readFile(pdfPath)

    // Fire-and-forget: the intermediate PDF carries the document's full text
    // layer — build the glossary word map from it, keyed by the same
    // cacheKey (the stored file URL) the slide cache uses.
    if (cacheKey) {
      const { extractLessonTextFromPdf } = require('../../utils/lessonTextExtract')
      extractLessonTextFromPdf(Buffer.from(pdfBuffer), cacheKey)
        .catch(err => console.warn('Lesson text extraction failed:', err.message))
    }
    const imagePaths = []
    let slideNum = 1

    for await (const pageBuffer of await pdf(pdfBuffer, { scale: 2 })) {
      const imgPath = path.join(tempDir, `slide_${slideNum}.png`)
      await fs.writeFile(imgPath, pageBuffer)
      imagePaths.push(imgPath)
      slideNum++
    }

    if (imagePaths.length === 0) throw new Error('No slides rendered')

    // 4. Upload to Cloudinary
    console.log(`☁️  Uploading ${imagePaths.length} slides...`)
    const stamp = Date.now()
    const uploads = await Promise.all(
      imagePaths.map((imgPath, idx) =>
        cloudinary.uploader.upload(imgPath, {
          folder: 'ppt-slides',
          public_id: `slide_${idx + 1}_${stamp}`,
          resource_type: 'image',
          format: 'jpg',
          transformation: [{ quality: 'auto:good' }],
        })
      )
    )

    const slideImages = uploads.map(r => r.secure_url)
    console.log(`✅ ${slideImages.length} slides ready`)

    // Persist to DB cache so future requests skip conversion entirely
    if (cacheKey) {
      PptCache.findOneAndUpdate(
        { pptUrl: cacheKey },
        { pptUrl: cacheKey, slideImages, totalSlides: slideImages.length },
        { upsert: true, new: true }
      ).catch(err => console.warn('Cache save failed:', err.message))
    }

    return { slideImages, totalSlides: slideImages.length }

  } finally {
    await fs.remove(tempDir).catch(() => {})
  }
}

// Delete the cached conversion for a document URL and destroy its slide images
// on Cloudinary. Used when a file is replaced/removed so orphaned slides don't
// pile up. Safe to fire-and-forget.
async function cleanupConvertedSlides(pptUrl) {
  if (!pptUrl) return
  const cached = await PptCache.findOneAndDelete({ pptUrl })
  if (!cached || !Array.isArray(cached.slideImages)) return
  await Promise.all(
    cached.slideImages.map(imageUrl => {
      // '.../upload/v17123/ppt-slides/slide_1_999.jpg' → 'ppt-slides/slide_1_999'
      const afterUpload = imageUrl.split('/upload/')[1]
      if (!afterUpload) return Promise.resolve()
      const publicId = afterUpload.replace(/^v\d+\//, '').replace(/\.[a-zA-Z0-9]+$/, '')
      return cloudinary.uploader.destroy(publicId)
        .catch(err => console.warn('Cloudinary slide cleanup failed:', err.message))
    })
  )
}

async function convertPptToImages(req, res) {
  // Accept either an uploaded file or a URL (URL used only if server can reach it)
  const hasUploadedFile = req.files && req.files.file
  const pptUrl = req.body?.pptUrl

  if (!hasUploadedFile && !pptUrl) {
    return res.status(400).json({ success: false, error: 'Either upload a file or provide pptUrl' })
  }

  // Check DB cache first — only possible when a URL is known
  const cacheKey = pptUrl || null
  if (cacheKey) {
    const cached = await PptCache.findOne({ pptUrl: cacheKey })
    if (cached && cached.slideImages.length > 0) {
      console.log('✅ Cache hit — returning stored slides')
      return res.json({ success: true, slideImages: cached.slideImages, totalSlides: cached.totalSlides, fromCache: true })
    }
  }

  try {
    // Detect the actual file extension so LibreOffice opens it correctly
    let ext = 'pptx'
    if (hasUploadedFile && req.files.file.name) {
      const m = req.files.file.name.match(/\.([a-zA-Z0-9]+)$/)
      if (m) ext = m[1].toLowerCase()
    } else if (pptUrl) {
      const m = pptUrl.split('?')[0].match(/\.([a-zA-Z0-9]+)$/)
      if (m) ext = m[1].toLowerCase()
    }

    let buffer
    if (hasUploadedFile) {
      // File sent directly from browser — no external download needed
      console.log(`📁 Using uploaded file (${ext})...`)
      buffer = req.files.file.data
    } else {
      // Fallback: download from URL
      console.log(`⬇️  Downloading file (${ext})...`)
      const response = await axios.get(pptUrl, { responseType: 'arraybuffer', timeout: 30000 })
      buffer = Buffer.from(response.data)
    }

    const { slideImages, totalSlides } = await convertDocumentToSlides({ buffer, ext, cacheKey })

    res.json({ success: true, slideImages, totalSlides })

  } catch (err) {
    console.error('❌ PPT conversion error:', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
}

module.exports = { convertPptToImages, convertDocumentToSlides, cleanupConvertedSlides }
