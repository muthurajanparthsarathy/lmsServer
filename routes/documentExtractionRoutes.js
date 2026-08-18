const express = require("express");
const router = express.Router();
const axios = require("axios");
const AdmZip = require('adm-zip');
const xml2js = require('xml2js');


// ==================== PDF PARSING SETUP ====================
// COPY FROM OLD FILE THAT WORKS
let pdfParse;

// Try different ways to import pdf-parse (EXACT SAME AS OLD FILE)
try {
  pdfParse = require("pdf-parse");
} catch (error) {
  try {
    const pdfParseModule = require("pdf-parse");
    pdfParse = pdfParseModule.default || pdfParseModule;
  } catch (error2) {
    pdfParse = null;
  }
}

// Additional imports
const mammoth = require("mammoth"); // For DOC/DOCX files

// ==================== UTILITY FUNCTIONS ====================

// Download file utility function (from old file)
async function downloadFile(url) {
  const response = await axios({
    method: 'GET',
    url: url,
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*'
    }
  });

  if (response.status !== 200) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }

  return Buffer.from(response.data);
}

// Extract text from PDF (EXACT COPY FROM OLD FILE)
async function extractPDFText(pdfBuffer) {
  if (!pdfParse) {
    throw new Error("PDF parsing library not available");
  }

  const data = await pdfParse(pdfBuffer);

  const cleanedText = data.text
    .replace(/\n\s*\n/g, '\n\n')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    text: cleanedText,
    pages: data.numpages,
    info: data.info,
    textLength: cleanedText.length,
    metadata: data.metadata
  };
}

// Basic text extraction fallback
function extractTextBasic(buffer) {
  try {
    const str = buffer.toString('utf8', 0, Math.min(buffer.length, 100000));
    const textMatches = str.match(/[A-Za-z0-9\s.,!?;:'"()\-+=@#$%^&*[\]{}|\\<>/`~]{10,}/g) || [];
    
    if (textMatches.length > 0) {
      return textMatches.join(' ').substring(0, 10000);
    }
    
    const encodings = ['utf16le', 'latin1', 'ascii'];
    for (const encoding of encodings) {
      try {
        const decoded = buffer.toString(encoding, 0, Math.min(buffer.length, 50000));
        const matches = decoded.match(/[A-Za-z0-9\s.,!?;:'"()\-+=]{20,}/g);
        if (matches && matches.length > 0) {
          return matches.join(' ').substring(0, 10000);
        }
      } catch (e) {
        // Continue
      }
    }
    
    return "Could not extract text content. The file may be encrypted or in an unsupported format.";
  } catch (error) {
    return `Error extracting text: ${error.message}`;
  }
}

// Extract text from DOC/DOCX
async function extractDOCText(docBuffer) {
  try {
    const result = await mammoth.extractRawText({ buffer: docBuffer });
    
    let cleanedText = result.value
      .replace(/\n\s*\n/g, '\n\n')
      .replace(/\s+/g, ' ')
      .trim();

    
    return {
      text: cleanedText,
      pages: 0,
      textLength: cleanedText.length,
      parserUsed: 'mammoth'
    };
  } catch (error) {
    console.error('DOC extraction error:', error.message);
    return {
      text: extractTextBasic(docBuffer),
      pages: 0,
      textLength: 0,
      parserUsed: 'mammoth-fallback'
    };
  }
}

// Extract text from PPT/PPTX
async function extractPPTText(pptBuffer) {
  try {
    // Check if it's a PPTX (which is a zip file)
    if (isPPTX(pptBuffer)) {
      const result = await extractPPTXText(pptBuffer);
      
      if (result.text && result.text.trim().length > 100) {
        return {
          text: result.text,
          pages: result.slideCount || 0,
          textLength: result.text.length,
          parserUsed: 'ppt-xml',
          note: "PPTX content extracted successfully"
        };
      }
    }
    
    // Fallback to basic extraction
    const basicText = extractTextBasic(pptBuffer);
    
    return {
      text: basicText,
      pages: 0,
      textLength: basicText.length,
      parserUsed: 'basic-ppt'
    };
    
  } catch (error) {
    console.error('PPT extraction error:', error.message);
    return {
      text: extractTextBasic(pptBuffer),
      pages: 0,
      textLength: 0,
      parserUsed: 'ppt-fallback'
    };
  }
}

// Check if buffer is a PPTX file (zip format)
function isPPTX(buffer) {
  // PPTX files start with PK header (zip format)
  return buffer.length > 4 && 
         buffer[0] === 0x50 && buffer[1] === 0x4B && 
         buffer[2] === 0x03 && buffer[3] === 0x04;
}

// Extract text from PPTX files
async function extractPPTXText(pptBuffer) {
  try {
    const zip = new AdmZip(pptBuffer);
    const zipEntries = zip.getEntries();
    
    let allText = "";
    let slideCount = 0;
    
    // Extract from slides
    const slideEntries = zipEntries.filter(entry => 
      entry.entryName.match(/ppt\/slides\/slide\d+\.xml/)
    );
    
    slideCount = slideEntries.length;
    
    for (const entry of slideEntries) {
      try {
        const content = zip.readAsText(entry);
        const slideText = await extractTextFromSlideXML(content);
        if (slideText) {
          allText += `Slide ${slideCount}: ${slideText}\n\n`;
        }
      } catch (slideError) {
      }
    }
    
    // Extract from notes if available
    const noteEntries = zipEntries.filter(entry => 
      entry.entryName.match(/ppt\/notesSlides\/notesSlide\d+\.xml/)
    );
    
    for (const entry of noteEntries) {
      try {
        const content = zip.readAsText(entry);
        const noteText = await extractTextFromNotesXML(content);
        if (noteText) {
          allText += `Notes: ${noteText}\n\n`;
        }
      } catch (noteError) {
      }
    }
    
    return {
      text: allText,
      slideCount: slideCount
    };
    
  } catch (error) {
    throw new Error(`PPTX extraction failed: ${error.message}`);
  }
}

// Extract text from slide XML
async function extractTextFromSlideXML(xmlContent) {
  return new Promise((resolve) => {
    xml2js.parseString(xmlContent, (err, result) => {
      if (err) {
        resolve("");
        return;
      }
      
      let text = "";
      
      try {
        if (result['p:sld'] && result['p:sld']['p:cSld']) {
          const cSld = result['p:sld']['p:cSld'][0];
          
          if (cSld['p:spTree'] && cSld['p:spTree'][0]['p:sp']) {
            const shapes = cSld['p:spTree'][0]['p:sp'];
            for (const shape of shapes) {
              if (shape['p:txBody'] && shape['p:txBody'][0]['a:p']) {
                const paragraphs = shape['p:txBody'][0]['a:p'];
                for (const paragraph of paragraphs) {
                  if (paragraph['a:r'] && paragraph['a:r'][0]['a:t']) {
                    const textRuns = paragraph['a:r'];
                    for (const textRun of textRuns) {
                      if (textRun['a:t'] && textRun['a:t'][0]) {
                        text += textRun['a:t'][0] + " ";
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } catch (parseError) {
      }
      
      resolve(text.trim());
    });
  });
}

// Extract text from notes XML
async function extractTextFromNotesXML(xmlContent) {
  return new Promise((resolve) => {
    xml2js.parseString(xmlContent, (err, result) => {
      if (err) {
        resolve("");
        return;
      }
      
      let text = "";
      
      try {
        if (result['p:notes'] && result['p:notes']['p:cSld']) {
          const cSld = result['p:notes']['p:cSld'][0];
          
          if (cSld['p:spTree'] && cSld['p:spTree'][0]['p:sp']) {
            const shapes = cSld['p:spTree'][0]['p:sp'];
            for (const shape of shapes) {
              if (shape['p:txBody'] && shape['p:txBody'][0]['a:p']) {
                const paragraphs = shape['p:txBody'][0]['a:p'];
                for (const paragraph of paragraphs) {
                  if (paragraph['a:r'] && paragraph['a:r'][0]['a:t']) {
                    const textRuns = paragraph['a:r'];
                    for (const textRun of textRuns) {
                      if (textRun['a:t'] && textRun['a:t'][0]) {
                        text += textRun['a:t'][0] + " ";
                      }
                    }
                  }
                }
              }
            }
          }
        }
      } catch (parseError) {
      }
      
      resolve(text.trim());
    });
  });
}

// Utility function to detect file type from URL (from old file)
function detectFileType(url) {
  if (!url) return 'unknown';

  const lowerUrl = url.toLowerCase();

  if (lowerUrl.includes('.pdf')) return 'pdf';
  if (lowerUrl.includes('.ppt') || lowerUrl.includes('.pptx')) return 'ppt';
  if (lowerUrl.includes('.doc') || lowerUrl.includes('.docx')) return 'doc';

  // Fallback: try to detect from extension
  const extension = url.split('.').pop().toLowerCase();
  switch(extension) {
    case 'pdf': return 'pdf';
    case 'ppt': case 'pptx': return 'ppt';
    case 'doc': case 'docx': return 'doc';
    default: return 'unknown';
  }
}

// ==================== ROUTES ====================

// ✅ Test endpoint
router.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "Document extraction service is running",
    timestamp: new Date().toISOString(),
    features: {
      pdf: pdfParse ? "Available (pdf-parse)" : "Not available",
      doc: "Available (mammoth)",
      ppt: "Available (adm-zip)",
      text: "Available"
    }
  });
});

// ✅ MAIN UPLOAD ENDPOINT
router.post("/upload-file", async (req, res) => {
  try {
    
    if (!req.files || !req.files.file) {
      console.error('❌ No file in request');
      return res.status(400).json({ 
        success: false, 
        error: 'No file uploaded. Please select a file.' 
      });
    }

    const uploadedFile = req.files.file;
    const fileName = uploadedFile.name;
    const fileSize = uploadedFile.size;
    const fileBuffer = uploadedFile.data;
    const mimetype = uploadedFile.mimetype;

    // Determine file type
    let fileCategory = 'other';
    if (mimetype.includes('pdf')) fileCategory = 'pdf';
    else if (mimetype.includes('presentation') || mimetype.includes('powerpoint') || 
             fileName.toLowerCase().includes('.ppt')) fileCategory = 'ppt';
    else if (mimetype.includes('video')) fileCategory = 'video';
    else if (mimetype.includes('text')) fileCategory = 'text';
    else if (mimetype.includes('word') || mimetype.includes('document') || 
             mimetype.includes('msword') || fileName.toLowerCase().includes('.doc')) fileCategory = 'doc';



    // Process the file
    let extractionResult;
    try {
      switch (fileCategory.toLowerCase()) {
        case 'pdf':
          extractionResult = await extractPDFText(fileBuffer);
          break;
        case 'doc':
        case 'docx':
          extractionResult = await extractDOCText(fileBuffer);
          break;
        case 'ppt':
        case 'pptx':
          extractionResult = await extractPPTText(fileBuffer);
          break;
        case 'text':
          extractionResult = {
            text: fileBuffer.toString('utf8'),
            pages: 0,
            textLength: fileBuffer.length,
            parserUsed: 'text'
          };
          break;
        default:
          extractionResult = {
            text: extractTextBasic(fileBuffer),
            pages: 0,
            textLength: 0,
            parserUsed: 'generic'
          };
      }


      res.json({
        success: true,
        message: "File processed successfully",
        data: {
          fileName: fileName,
          fileType: fileCategory,
          fileSize: fileSize,
          extractedText: extractionResult.text,
          textLength: extractionResult.text.length,
          pages: extractionResult.pages || 0,
          parserUsed: extractionResult.parserUsed || 'unknown',
          info: extractionResult.info || {},
          metadata: extractionResult.metadata || {}
        }
      });

    } catch (extractionError) {
      console.error("❌ Extraction error:", extractionError);
      // Fallback to basic extraction
      res.json({
        success: true,
        message: "File processed with basic extraction",
        data: {
          fileName: fileName,
          fileType: fileCategory,
          fileSize: fileSize,
          extractedText: extractTextBasic(fileBuffer),
          textLength: 0,
          pages: 0,
          parserUsed: 'emergency-fallback'
        }
      });
    }

  } catch (error) {
    console.error("❌ Upload/processing error:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message || "File processing failed"
    });
  }
});

// ✅ Extract text from URL-based files (NEW VERSION WITH WORKING PDF)
router.post("/extract-file-text", async (req, res) => {
  try {
    const { fileUrl, fileType } = req.body;

    if (!fileUrl) {
      return res.status(400).json({ success: false, error: "File URL required" });
    }

    // Detect file type if not provided
    let detectedType = fileType;
    if (!detectedType) {
      detectedType = detectFileType(fileUrl);
    }

    if (detectedType === 'unknown') {
      return res.status(400).json({ 
        success: false, 
        error: "Unable to detect file type. Please specify fileType parameter." 
      });
    }

    const fileBuffer = await downloadFile(fileUrl);
    
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new Error("Downloaded file is empty");
    }


    let extractionResult;
    switch (detectedType.toLowerCase()) {
      case 'pdf':
        extractionResult = await extractPDFText(fileBuffer);
        break;
      case 'doc':
      case 'docx':
        extractionResult = await extractDOCText(fileBuffer);
        break;
      case 'ppt':
      case 'pptx':
        extractionResult = await extractPPTText(fileBuffer);
        break;
      case 'text':
        extractionResult = {
          text: fileBuffer.toString('utf8'),
          pages: 0,
          textLength: fileBuffer.length,
          parserUsed: 'text'
        };
        break;
      default:
        throw new Error(`Unsupported file type: ${detectedType}`);
    }


    res.json({
      success: true,
      fileType: detectedType,
      text: extractionResult.text,
      pages: extractionResult.pages || 0,
      textLength: extractionResult.textLength || 0,
      parserUsed: extractionResult.parserUsed || 'unknown',
      info: extractionResult.info || {},
      metadata: extractionResult.metadata || {},
      extractedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error("❌ URL extraction error:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message || "Failed to extract text from URL",
      details: "Please ensure the file is accessible, not password protected, and contains extractable text."
    });
  }
});

// ✅ PDF-specific extraction endpoint (WORKING VERSION FROM OLD FILE)
router.post("/extract-pdf-text", async (req, res) => {
  try {
    const { pdfUrl } = req.body;

    if (!pdfUrl) {
      return res.status(400).json({ success: false, error: "PDF URL required" });
    }


    // Download PDF file (same as old file)
    const response = await axios({
      method: 'GET',
      url: pdfUrl,
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/pdf, */*'
      }
    });

    if (response.status !== 200) {
      throw new Error(`Failed to download PDF: ${response.status} ${response.statusText}`);
    }

    const pdfBuffer = Buffer.from(response.data);

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("Downloaded PDF is empty or invalid");
    }

    // Extract text from PDF
    const extractionResult = await extractPDFText(pdfBuffer);


    res.json({
      success: true,
      text: extractionResult.text,
      pages: extractionResult.pages,
      info: extractionResult.info,
      textLength: extractionResult.textLength,
      metadata: extractionResult.metadata,
      extractedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error("PDF text extraction error:", error.message);
    
    let errorMessage = error.message;
    if (error.message.includes('Failed to download PDF')) {
      errorMessage = `Unable to download PDF from the provided URL. Please check if the PDF is accessible.`;
    }

    res.status(500).json({    
      success: false,
      error: errorMessage,
      details: "Failed to extract text from PDF. Please ensure the PDF is accessible, not password protected, and contains extractable text."
    });
  }
});

// ✅ PDF extraction with fallback (for compatibility)
router.post("/extract-pdf-text-pdfjs", async (req, res) => {
  try {
    const { pdfUrl } = req.body;

    if (!pdfUrl) {
      return res.status(400).json({ success: false, error: "PDF URL required" });
    }

    const fileBuffer = await downloadFile(pdfUrl);
    
    // Use the main PDF extraction function
    const extractionResult = await extractPDFText(fileBuffer);

    res.json({
      success: true,
      text: extractionResult.text,
      pages: extractionResult.pages,
      textLength: extractionResult.textLength,
      parserUsed: 'pdf-parse',
      extractedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error("❌ PDF extraction error:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message || "PDF extraction failed"
    });
  }
});

module.exports = router;