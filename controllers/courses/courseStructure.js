const CourseStructure = require("../../models/Courses/courseStructureModal");
const CourseStructureDynamic = require("../../models/dynamicContent/courseStructureDynamicModal");
const mongoose = require("mongoose");
// Approval-workflow count needs to walk the pedagogy maps on each entity type.
require("../../models/Courses/moduleStructure/moduleModal");
require("../../models/Courses/moduleStructure/subModuleModal");
require("../../models/Courses/moduleStructure/topicModal");
require("../../models/Courses/moduleStructure/subTopicModal");
const Module1 = mongoose.model("Module1");
const SubModule1 = mongoose.model("SubModule1");
const Topic1 = mongoose.model("Topic1");
const SubTopic1 = mongoose.model("SubTopic1");
const { createClient } = require("@supabase/supabase-js");
const supabaseKey = process.env.SUPABASE_KEY;
const supabaseUrl = process.env.SUPABASE_URL;

const supabase = createClient(supabaseUrl, supabaseKey);
const User = require("../../models/UserModel");
// (Role is required further down, by the approval-hierarchy section — a
// second top-level require here would redeclare the identifier.)
const { sendEmail } = require("../../utils/sendEmail");

// The Resources-by-batch config crosses the multipart boundary as a JSON
// string (same route clientConfigurations takes). Returns undefined for
// absent/unparseable input so update paths can leave the stored value alone.
const parseBatchResources = (value) => {
  try {
    if (value === undefined || value === null || value === "") return undefined;
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object") return undefined;
    return {
      sameForAllBatches: parsed.sameForAllBatches !== false,
      batchwiseElements: Array.isArray(parsed.batchwiseElements)
        ? parsed.batchwiseElements.filter((e) =>
            ["I_Do", "We_Do", "You_Do"].includes(e)
          )
        : [],
    };
  } catch {
    return undefined;
  }
};
const { cascadeDeleteCourses } = require("../../utils/cascadeDeleteCourses");


exports.createCourseStructure = async (req, res) => {
  try {
    console.log('=== Create Course Request ===');
    console.log('Has files:', !!req.files);
    console.log('Files keys:', req.files ? Object.keys(req.files) : 'none');
    
    let resourcesType = { iDo: {}, weDo: {}, youDo: {} };
    
    // Helper function to parse nested object fields with proper AI handling
    const parseNestedObject = (prefix) => {
      const result = {
        video: { 
          enabled: false, 
          maxSize: 50, 
          allowedFormats: ['mp4', 'mov', 'avi', 'webm'],
          aiChat: false,
          aiSummary: false
        },
        ppt: { 
          enabled: false, 
          maxSize: 20, 
          allowedFormats: ['ppt', 'pptx'],
          aiChat: false,
          aiSummary: false
        },
        pdf: {
          enabled: false,
          maxSize: 10,
          allowedFormats: ['pdf'],
          aiChat: false,
          aiSummary: false,
          notes: false
        },
        image: {
          enabled: false,
          maxSize: 10,
          allowedFormats: [],
          aiChat: false,
          aiSummary: false,
          notes: false
        },
        zip: {
          enabled: false,
          maxSize: 100,
          allowedFormats: []
        },
        url: { enabled: false },
        ai: { enabled: false },
        aiChat: { enabled: false, config: { model: 'gpt-3.5-turbo', temperature: 0.7 } },
        aiSummary: { enabled: false, config: { length: 'medium', language: 'en' } },
        notes: { enabled: false },
        autoQuestionGenerate: { enabled: false }
      };

      // Parse video fields
      if (req.body[`${prefix}[video][enabled]`] !== undefined) {
        result.video.enabled = req.body[`${prefix}[video][enabled]`] === 'true';
      }
      if (req.body[`${prefix}[video][maxSize]`] !== undefined) {
        result.video.maxSize = parseFloat(req.body[`${prefix}[video][maxSize]`]);
      }
      // Parse video AI Chat
      if (req.body[`${prefix}[video][aiChat]`] !== undefined) {
        result.video.aiChat = req.body[`${prefix}[video][aiChat]`] === 'true';
      }
      // Parse video AI Summary
      if (req.body[`${prefix}[video][aiSummary]`] !== undefined) {
        result.video.aiSummary = req.body[`${prefix}[video][aiSummary]`] === 'true';
      }
      // Parse video per-type Notes toggle
      if (req.body[`${prefix}[video][notes]`] !== undefined) {
        result.video.notes = req.body[`${prefix}[video][notes]`] === 'true';
      }

      // Parse ppt fields
      if (req.body[`${prefix}[ppt][enabled]`] !== undefined) {
        result.ppt.enabled = req.body[`${prefix}[ppt][enabled]`] === 'true';
      }
      if (req.body[`${prefix}[ppt][maxSize]`] !== undefined) {
        result.ppt.maxSize = parseFloat(req.body[`${prefix}[ppt][maxSize]`]);
      }
      // Parse ppt AI Chat
      if (req.body[`${prefix}[ppt][aiChat]`] !== undefined) {
        result.ppt.aiChat = req.body[`${prefix}[ppt][aiChat]`] === 'true';
      }
      // Parse ppt AI Summary
      if (req.body[`${prefix}[ppt][aiSummary]`] !== undefined) {
        result.ppt.aiSummary = req.body[`${prefix}[ppt][aiSummary]`] === 'true';
      }
      // Parse ppt per-type Notes toggle
      if (req.body[`${prefix}[ppt][notes]`] !== undefined) {
        result.ppt.notes = req.body[`${prefix}[ppt][notes]`] === 'true';
      }

      // Parse pdf fields
      if (req.body[`${prefix}[pdf][enabled]`] !== undefined) {
        result.pdf.enabled = req.body[`${prefix}[pdf][enabled]`] === 'true';
      }
      if (req.body[`${prefix}[pdf][maxSize]`] !== undefined) {
        result.pdf.maxSize = parseFloat(req.body[`${prefix}[pdf][maxSize]`]);
      }
      // Parse pdf AI Chat
      if (req.body[`${prefix}[pdf][aiChat]`] !== undefined) {
        result.pdf.aiChat = req.body[`${prefix}[pdf][aiChat]`] === 'true';
      }
      // Parse pdf AI Summary
      if (req.body[`${prefix}[pdf][aiSummary]`] !== undefined) {
        result.pdf.aiSummary = req.body[`${prefix}[pdf][aiSummary]`] === 'true';
      }
      // Parse pdf per-type Notes toggle
      if (req.body[`${prefix}[pdf][notes]`] !== undefined) {
        result.pdf.notes = req.body[`${prefix}[pdf][notes]`] === 'true';
      }

      // Parse image fields
      if (req.body[`${prefix}[image][enabled]`] !== undefined) {
        result.image.enabled = req.body[`${prefix}[image][enabled]`] === 'true';
      }
      if (req.body[`${prefix}[image][maxSize]`] !== undefined) {
        result.image.maxSize = parseFloat(req.body[`${prefix}[image][maxSize]`]);
      }
      // Parse image AI Chat
      if (req.body[`${prefix}[image][aiChat]`] !== undefined) {
        result.image.aiChat = req.body[`${prefix}[image][aiChat]`] === 'true';
      }
      // Parse image AI Summary
      if (req.body[`${prefix}[image][aiSummary]`] !== undefined) {
        result.image.aiSummary = req.body[`${prefix}[image][aiSummary]`] === 'true';
      }
      // Parse image per-type Notes toggle
      if (req.body[`${prefix}[image][notes]`] !== undefined) {
        result.image.notes = req.body[`${prefix}[image][notes]`] === 'true';
      }

      // Parse zip fields
      if (req.body[`${prefix}[zip][enabled]`] !== undefined) {
        result.zip.enabled = req.body[`${prefix}[zip][enabled]`] === 'true';
      }
      if (req.body[`${prefix}[zip][maxSize]`] !== undefined) {
        result.zip.maxSize = parseFloat(req.body[`${prefix}[zip][maxSize]`]);
      }

      // Parse url
      if (req.body[`${prefix}[url][enabled]`] !== undefined) {
        result.url.enabled = req.body[`${prefix}[url][enabled]`] === 'true';
      }

      // Parse ai (standalone "AI-generated content" resource type)
      if (req.body[`${prefix}[ai][enabled]`] !== undefined) {
        result.ai.enabled = req.body[`${prefix}[ai][enabled]`] === 'true';
      }

      // Parse aiChat (global for I_Do)
      if (req.body[`${prefix}[aiChat][enabled]`] !== undefined) {
        result.aiChat.enabled = req.body[`${prefix}[aiChat][enabled]`] === 'true';
      }
      if (req.body[`${prefix}[aiChat][config][model]`] !== undefined) {
        result.aiChat.config.model = req.body[`${prefix}[aiChat][config][model]`];
      }
      if (req.body[`${prefix}[aiChat][config][temperature]`] !== undefined) {
        result.aiChat.config.temperature = parseFloat(req.body[`${prefix}[aiChat][config][temperature]`]);
      }

      // Parse aiSummary (global for I_Do)
      if (req.body[`${prefix}[aiSummary][enabled]`] !== undefined) {
        result.aiSummary.enabled = req.body[`${prefix}[aiSummary][enabled]`] === 'true';
      }
      if (req.body[`${prefix}[aiSummary][config][length]`] !== undefined) {
        result.aiSummary.config.length = req.body[`${prefix}[aiSummary][config][length]`];
      }
      if (req.body[`${prefix}[aiSummary][config][language]`] !== undefined) {
        result.aiSummary.config.language = req.body[`${prefix}[aiSummary][config][language]`];
      }

      // Parse notes (standalone "Notes" resource type)
      if (req.body[`${prefix}[notes][enabled]`] !== undefined) {
        result.notes.enabled = req.body[`${prefix}[notes][enabled]`] === 'true';
      }

      // Parse autoQuestionGenerate (We Do / You Do)
      if (req.body[`${prefix}[autoQuestionGenerate][enabled]`] !== undefined) {
        result.autoQuestionGenerate.enabled = req.body[`${prefix}[autoQuestionGenerate][enabled]`] === 'true';
      }

      return result;
    };

    // Parse resources for each pedagogy type
    resourcesType.iDo = parseNestedObject('resourcesType[iDo]');
    resourcesType.weDo = parseNestedObject('resourcesType[weDo]');
    resourcesType.youDo = parseNestedObject('resourcesType[youDo]');
    
    // Parse testConfiguration configuration (flat format: { coreProgram, frontend, database })
    const parseTestConfigurationConfig = () => {
      const result = { coreProgram: [], frontend: [], database: [] };
      const coreProgramPattern = /^testConfiguration\[coreProgram\](?:\[(\d+)\])?$/;
      const frontendPattern = /^testConfiguration\[frontend\](?:\[(\d+)\])?$/;
      const databasePattern = /^testConfiguration\[database\](?:\[(\d+)\])?$/;

      for (let key in req.body) {
        const value = req.body[key];
        if (!value) continue;
        if (coreProgramPattern.test(key) && !result.coreProgram.includes(value)) {
          result.coreProgram.push(value);
        } else if (frontendPattern.test(key) && !result.frontend.includes(value)) {
          result.frontend.push(value);
        } else if (databasePattern.test(key) && !result.database.includes(value)) {
          result.database.push(value);
        }
      }
      return result;
    };

    const testConfigurationConfig = parseTestConfigurationConfig();
    console.log('Parsed testConfiguration config:', JSON.stringify(testConfigurationConfig, null, 2));
    
    // Parse arrays from form data
    const parseArrayField = (fieldName) => {
      const values = [];
      for (let key in req.body) {
        if (key.startsWith(`${fieldName}[`) && key.endsWith(']')) {
          values.push(req.body[key]);
        }
      }
      if (req.body[fieldName] && Array.isArray(req.body[fieldName])) {
        return req.body[fieldName];
      }
      return values.length > 0 ? values : (req.body[fieldName] || []);
    };
    
    const courseHierarchy = parseArrayField('courseHierarchy');
    const I_Do = parseArrayField('I_Do');
    const We_Do = parseArrayField('We_Do');
    const You_Do = parseArrayField('You_Do');
    // Skilling engagements can target multiple batches (multi-select)
    const skillingBatches = parseArrayField('skillingBatches');
    // The course's own batch names from the mapping (Degree Program per-course
    // batches). Sent as a JSON string — like clientConfigurations — so an empty
    // list is distinguishable from the field not being sent at all.
    let courseBatches = [];
    if (req.body.batches !== undefined) {
      try {
        const parsed = typeof req.body.batches === 'string'
          ? JSON.parse(req.body.batches)
          : req.body.batches;
        if (Array.isArray(parsed)) {
          courseBatches = parsed.map((b) => String(b).trim()).filter(Boolean);
        }
      } catch { /* malformed JSON → treat as none */ }
    }

    const {
      clientId,
      clientName,
      serviceType,
      serviceModal,
      category,
      courseCode,
      // The ServiceMapping this setup came from — must be whitelisted here or
      // strict mode silently drops it and mapping-scoped identity breaks.
      mappingId,
      // WHERE in that mapping the course sits. Same strict-mode trap: without
      // it, the same course name under two departments collapses into one setup.
      coursePath,
      // Batch-wise content config from the Resources-by-batch section.
      batchResources,
      courseName,
      courseDescription,
      courseDuration,
      courseLevel,
      aiChatGlobal,
      studentType,
      batch,
      degree,
    } = req.body;

    console.log('Parsed resourcesType:', JSON.stringify(resourcesType, null, 2));

    // Check if courseCode already exists (existence only — no doc fields read)
    if (courseCode) {
      const existingCourse = await CourseStructure.findOne({ courseCode })
        .select("_id")
        .lean();
      if (existingCourse) {
        return res.status(403).json({
          message: [{ key: "error", value: "Course Code already exists" }],
        });
      }
    }

    // Required fields check. Category is NOT required for Placement Training: a
    // placement course carries no category (its phase/name IS the course), so
    // requiring it rejected every placement course setup with "Required fields
    // are missing" even when the form was fully filled in.
    const categoryRequired = !/placement/i.test(String(serviceModal || ""));
    if (!clientId || !serviceType || !serviceModal || (categoryRequired && !category) || !courseName) {
      return res.status(400).json({
        message: [{ key: "error", value: "Required fields are missing" }],
      });
    }

    // Validate if clientId is a valid MongoDB ObjectId
    if (!mongoose.Types.ObjectId.isValid(clientId)) {
      return res.status(400).json({
        message: [{ key: "error", value: "Invalid client ID format" }],
      });
    }

    // Check if the client exists in Client Management (only clientCompany read)
    const ClientManagement = mongoose.model("LMS-ClientManagement");
    const clientDoc = await ClientManagement.findById(clientId)
      .select("clientCompany")
      .lean();

    if (!clientDoc) {
      return res.status(404).json({
        message: [{ key: "error", value: "Client not found in the system" }],
      });
    }
    // Prefer the sent name, else the client's company name
    const resolvedClientName = clientName || clientDoc.clientCompany || "";

    // Parse departmentSections (nested array of { department, sections[], semesters[] })
    const parseDepartmentSections = () => {
      const byIndex = {};
      const deptPattern = /^departmentSections\[(\d+)\]\[department\]$/;
      const secPattern = /^departmentSections\[(\d+)\]\[sections\]\[(\d+)\]$/;
      const semPattern = /^departmentSections\[(\d+)\]\[semesters\]\[(\d+)\]$/;
      const ensure = (i) => (byIndex[i] = byIndex[i] || { department: "", sections: [], semesters: [] });
      for (const key in req.body) {
        const val = req.body[key];
        let m;
        if ((m = key.match(deptPattern))) {
          ensure(m[1]).department = val;
        } else if ((m = key.match(secPattern))) {
          ensure(m[1]).sections[parseInt(m[2], 10)] = val;
        } else if ((m = key.match(semPattern))) {
          ensure(m[1]).semesters[parseInt(m[2], 10)] = val;
        }
      }
      return Object.keys(byIndex)
        .sort((a, b) => Number(a) - Number(b))
        .map((i) => ({
          department: byIndex[i].department,
          sections: (byIndex[i].sections || []).filter(Boolean),
          semesters: (byIndex[i].semesters || []).filter(Boolean),
        }))
        .filter((d) => d.department || d.sections.length || d.semesters.length);
    };
    const departmentSections = parseDepartmentSections();

    // Multiple client-configuration blocks (sent as a JSON string)
    let clientConfigurations = [];
    try {
      const raw = req.body.clientConfigurations ? JSON.parse(req.body.clientConfigurations) : [];
      clientConfigurations = (Array.isArray(raw) ? raw : [])
        .map((c) => ({
          batch: String((c && c.batch) || "").trim(),
          degree: String((c && c.degree) || "").trim(),
          departments: (Array.isArray(c && c.departmentSections) ? c.departmentSections : (c && c.departments) || [])
            .map((d) => ({
              department: String((d && d.department) || "").trim(),
              sections: Array.isArray(d && d.sections) ? d.sections.map((s) => String(s).trim()).filter(Boolean) : [],
              semesters: Array.isArray(d && d.semesters) ? d.semesters.map((s) => String(s).trim()).filter(Boolean) : [],
            }))
            .filter((d) => d.department || d.sections.length || d.semesters.length),
        }))
        .filter((c) => c.batch || c.degree || c.departments.length);
    } catch (e) {
      clientConfigurations = [];
    }
    
    // Image upload handler
    let imageUrl = undefined;
    
    const extractFileData = (fileInput) => {
      let fileObj = fileInput;
      if (Array.isArray(fileInput)) {
        fileObj = fileInput[0];
      }
      
      if (!fileObj) return null;
      
      let fileData = null;
      let fileName = null;
      let mimeType = null;
      
      if (fileObj.data) {
        fileData = fileObj.data;
        fileName = fileObj.name || fileObj.originalname || 'image';
        mimeType = fileObj.mimetype || fileObj.type || 'image/jpeg';
      } 
      else if (fileObj.buffer) {
        fileData = fileObj.buffer;
        fileName = fileObj.originalname || fileObj.name || 'image';
        mimeType = fileObj.mimetype || fileObj.type || 'image/jpeg';
      }
      else if (fileObj.path) {
        const fs = require('fs');
        if (fs.existsSync(fileObj.path)) {
          fileData = fs.readFileSync(fileObj.path);
          fileName = fileObj.originalname || fileObj.name || 'image';
          mimeType = fileObj.mimetype || fileObj.type || 'image/jpeg';
        }
      }
      
      return fileData ? { fileData, fileName, mimeType } : null;
    };
    
    if (req.files && req.files.courseImage) {
      try {
        const extracted = extractFileData(req.files.courseImage);
        
        if (extracted) {
          const { fileData, fileName, mimeType } = extracted;
          
          console.log('Processing image:', {
            fileName: fileName,
            fileSize: fileData.length,
            fileType: mimeType,
          });
          
          if (fileData.length > 5 * 1024 * 1024) {
            return res.status(400).json({
              message: [{ key: "error", value: "Image size should be less than 5MB" }],
            });
          }
          
          const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
          if (!validTypes.includes(mimeType)) {
            return res.status(400).json({
              message: [{ key: "error", value: "Only JPEG, JPG, PNG, WebP, and GIF formats are allowed" }],
            });
          }
          
          const timestamp = Date.now();
          const extension = mimeType.split('/')[1] || 'jpg';
          const baseFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
          const uniqueFileName = `${timestamp}_${baseFileName}`;
          
          console.log('Uploading to Supabase:', uniqueFileName);
          
          const { error: uploadError } = await supabase.storage
            .from("smartlms")
            .upload(`course/image/${uniqueFileName}`, fileData, {
              contentType: mimeType,
              cacheControl: '3600',
              upsert: false
            });
          
          if (!uploadError) {
            const { data: publicUrlData } = supabase.storage
              .from("smartlms")
              .getPublicUrl(`course/image/${uniqueFileName}`);
            
            imageUrl = publicUrlData.publicUrl;
            console.log('Image URL generated:', imageUrl);
          }
        }
      } catch (error) {
        console.error("Error processing image:", error);
      }
    }
    
    // Create and save course with testConfiguration configuration
    const newCourse = new CourseStructure({
      institution: req.user.institution,
      clientId,
      clientName: resolvedClientName,
      serviceType,
      serviceModal,
      category,
      courseCode,
      mappingId: mappingId || "",
      coursePath: coursePath || "",
      // Arrives as a JSON string (multipart form, like clientConfigurations).
      batchResources: parseBatchResources(batchResources) || {
        sameForAllBatches: true,
        batchwiseElements: [],
      },
      courseName,
      courseDescription: courseDescription || "",
      courseDuration: courseDuration || "",
      courseLevel,
      aiChatGlobal: aiChatGlobal === 'true' || aiChatGlobal === true,
      studentType: studentType || "",
      batch: batch || "",
      degree: degree || "",
      departmentSections: departmentSections || [],
      clientConfigurations: clientConfigurations || [],
      skillingBatches: skillingBatches || [],
      batches: courseBatches,
      resourcesType: resourcesType,
      testConfiguration: testConfigurationConfig,
      courseHierarchy: courseHierarchy,
      I_Do: I_Do,
      We_Do: We_Do,
      You_Do: You_Do,
      courseImage: imageUrl,
      createdBy: req.user.email,
    });
    
    const savedCourse = await newCourse.save();
    
    console.log("Course saved successfully:", {
      id: savedCourse._id,
      courseName: savedCourse.courseName,
      testConfiguration: savedCourse.testConfiguration,
      resourcesType: {
        iDo: {
          video: { aiChat: savedCourse.resourcesType.iDo.video?.aiChat, aiSummary: savedCourse.resourcesType.iDo.video?.aiSummary },
          ppt: { aiChat: savedCourse.resourcesType.iDo.ppt?.aiChat, aiSummary: savedCourse.resourcesType.iDo.ppt?.aiSummary },
          pdf: { aiChat: savedCourse.resourcesType.iDo.pdf?.aiChat, aiSummary: savedCourse.resourcesType.iDo.pdf?.aiSummary }
        },
        weDo: {
          aiChat: savedCourse.resourcesType.weDo.aiChat?.enabled,
          aiSummary: savedCourse.resourcesType.weDo.aiSummary?.enabled,
          notes: savedCourse.resourcesType.weDo.notes?.enabled
        },
        youDo: {
          aiChat: savedCourse.resourcesType.youDo.aiChat?.enabled,
          aiSummary: savedCourse.resourcesType.youDo.aiSummary?.enabled,
          notes: savedCourse.resourcesType.youDo.notes?.enabled
        }
      }
    });
    
    return res.status(201).json({
      message: [{ key: "success", value: "Course structure created successfully" }],
      data: savedCourse,
    });
    
  } catch (error) {
    console.error("Error adding course structure:", error);
    return res.status(500).json({
      message: [{ key: "error", value: "Server error while adding course structure: " + error.message }],
    });
  }
};
exports.updateCourseStructure = async (req, res) => {
  try {
    const { courseId } = req.params;
    
   
    // Parse nested resourcesType configuration from form data (same as create)
    let resourcesType = { iDo: {}, weDo: {}, youDo: {} };
    
    // Helper function to parse nested object fields with proper AI handling
    const parseNestedObject = (prefix) => {
      const result = {
        video: { 
          enabled: false, 
          maxSize: 50, 
          allowedFormats: ['mp4', 'mov', 'avi', 'webm'],
          aiChat: false,
          aiSummary: false
        },
        ppt: { 
          enabled: false, 
          maxSize: 20, 
          allowedFormats: ['ppt', 'pptx'],
          aiChat: false,
          aiSummary: false
        },
        pdf: {
          enabled: false,
          maxSize: 10,
          allowedFormats: ['pdf'],
          aiChat: false,
          aiSummary: false,
          notes: false
        },
        image: {
          enabled: false,
          maxSize: 10,
          allowedFormats: [],
          aiChat: false,
          aiSummary: false,
          notes: false
        },
        zip: {
          enabled: false,
          maxSize: 100,
          allowedFormats: []
        },
        url: { enabled: false },
        ai: { enabled: false },
        aiChat: { enabled: false, config: { model: 'gpt-3.5-turbo', temperature: 0.7 } },
        aiSummary: { enabled: false, config: { length: 'medium', language: 'en' } },
        notes: { enabled: false },
        autoQuestionGenerate: { enabled: false }
      };

      // Parse video fields
      if (req.body[`${prefix}[video][enabled]`] !== undefined) {
        result.video.enabled = req.body[`${prefix}[video][enabled]`] === 'true';
      }
      if (req.body[`${prefix}[video][maxSize]`] !== undefined) {
        result.video.maxSize = parseFloat(req.body[`${prefix}[video][maxSize]`]);
      }
      if (req.body[`${prefix}[video][aiChat]`] !== undefined) {
        result.video.aiChat = req.body[`${prefix}[video][aiChat]`] === 'true';
      }
      if (req.body[`${prefix}[video][aiSummary]`] !== undefined) {
        result.video.aiSummary = req.body[`${prefix}[video][aiSummary]`] === 'true';
      }
      if (req.body[`${prefix}[video][notes]`] !== undefined) {
        result.video.notes = req.body[`${prefix}[video][notes]`] === 'true';
      }

      // Parse ppt fields
      if (req.body[`${prefix}[ppt][enabled]`] !== undefined) {
        result.ppt.enabled = req.body[`${prefix}[ppt][enabled]`] === 'true';
      }
      if (req.body[`${prefix}[ppt][maxSize]`] !== undefined) {
        result.ppt.maxSize = parseFloat(req.body[`${prefix}[ppt][maxSize]`]);
      }
      if (req.body[`${prefix}[ppt][aiChat]`] !== undefined) {
        result.ppt.aiChat = req.body[`${prefix}[ppt][aiChat]`] === 'true';
      }
      if (req.body[`${prefix}[ppt][aiSummary]`] !== undefined) {
        result.ppt.aiSummary = req.body[`${prefix}[ppt][aiSummary]`] === 'true';
      }
      if (req.body[`${prefix}[ppt][notes]`] !== undefined) {
        result.ppt.notes = req.body[`${prefix}[ppt][notes]`] === 'true';
      }

      // Parse pdf fields
      if (req.body[`${prefix}[pdf][enabled]`] !== undefined) {
        result.pdf.enabled = req.body[`${prefix}[pdf][enabled]`] === 'true';
      }
      if (req.body[`${prefix}[pdf][maxSize]`] !== undefined) {
        result.pdf.maxSize = parseFloat(req.body[`${prefix}[pdf][maxSize]`]);
      }
      if (req.body[`${prefix}[pdf][aiChat]`] !== undefined) {
        result.pdf.aiChat = req.body[`${prefix}[pdf][aiChat]`] === 'true';
      }
      if (req.body[`${prefix}[pdf][aiSummary]`] !== undefined) {
        result.pdf.aiSummary = req.body[`${prefix}[pdf][aiSummary]`] === 'true';
      }
      if (req.body[`${prefix}[pdf][notes]`] !== undefined) {
        result.pdf.notes = req.body[`${prefix}[pdf][notes]`] === 'true';
      }

      // Parse image fields
      if (req.body[`${prefix}[image][enabled]`] !== undefined) {
        result.image.enabled = req.body[`${prefix}[image][enabled]`] === 'true';
      }
      if (req.body[`${prefix}[image][maxSize]`] !== undefined) {
        result.image.maxSize = parseFloat(req.body[`${prefix}[image][maxSize]`]);
      }
      if (req.body[`${prefix}[image][aiChat]`] !== undefined) {
        result.image.aiChat = req.body[`${prefix}[image][aiChat]`] === 'true';
      }
      if (req.body[`${prefix}[image][aiSummary]`] !== undefined) {
        result.image.aiSummary = req.body[`${prefix}[image][aiSummary]`] === 'true';
      }
      if (req.body[`${prefix}[image][notes]`] !== undefined) {
        result.image.notes = req.body[`${prefix}[image][notes]`] === 'true';
      }

      // Parse zip fields
      if (req.body[`${prefix}[zip][enabled]`] !== undefined) {
        result.zip.enabled = req.body[`${prefix}[zip][enabled]`] === 'true';
      }
      if (req.body[`${prefix}[zip][maxSize]`] !== undefined) {
        result.zip.maxSize = parseFloat(req.body[`${prefix}[zip][maxSize]`]);
      }

      // Parse url
      if (req.body[`${prefix}[url][enabled]`] !== undefined) {
        result.url.enabled = req.body[`${prefix}[url][enabled]`] === 'true';
      }

      // Parse ai (standalone "AI-generated content" resource type)
      if (req.body[`${prefix}[ai][enabled]`] !== undefined) {
        result.ai.enabled = req.body[`${prefix}[ai][enabled]`] === 'true';
      }

      // Parse aiChat
      if (req.body[`${prefix}[aiChat][enabled]`] !== undefined) {
        result.aiChat.enabled = req.body[`${prefix}[aiChat][enabled]`] === 'true';
      }
      if (req.body[`${prefix}[aiChat][config][model]`] !== undefined) {
        result.aiChat.config.model = req.body[`${prefix}[aiChat][config][model]`];
      }
      if (req.body[`${prefix}[aiChat][config][temperature]`] !== undefined) {
        result.aiChat.config.temperature = parseFloat(req.body[`${prefix}[aiChat][config][temperature]`]);
      }

      // Parse aiSummary
      if (req.body[`${prefix}[aiSummary][enabled]`] !== undefined) {
        result.aiSummary.enabled = req.body[`${prefix}[aiSummary][enabled]`] === 'true';
      }
      if (req.body[`${prefix}[aiSummary][config][length]`] !== undefined) {
        result.aiSummary.config.length = req.body[`${prefix}[aiSummary][config][length]`];
      }
      if (req.body[`${prefix}[aiSummary][config][language]`] !== undefined) {
        result.aiSummary.config.language = req.body[`${prefix}[aiSummary][config][language]`];
      }

      // Parse notes (standalone "Notes" resource type)
      if (req.body[`${prefix}[notes][enabled]`] !== undefined) {
        result.notes.enabled = req.body[`${prefix}[notes][enabled]`] === 'true';
      }

      // Parse autoQuestionGenerate (We Do / You Do)
      if (req.body[`${prefix}[autoQuestionGenerate][enabled]`] !== undefined) {
        result.autoQuestionGenerate.enabled = req.body[`${prefix}[autoQuestionGenerate][enabled]`] === 'true';
      }

      return result;
    };

    // Parse resources for each pedagogy type
    resourcesType.iDo = parseNestedObject('resourcesType[iDo]');
    resourcesType.weDo = parseNestedObject('resourcesType[weDo]');
    resourcesType.youDo = parseNestedObject('resourcesType[youDo]');

    // ========== Parse testConfiguration configuration (flat format) ==========
    const parseTestConfigurationConfig = () => {
      const result = { coreProgram: [], frontend: [], database: [] };
      const coreProgramPattern = /^testConfiguration\[coreProgram\](?:\[(\d+)\])?$/;
      const frontendPattern = /^testConfiguration\[frontend\](?:\[(\d+)\])?$/;
      const databasePattern = /^testConfiguration\[database\](?:\[(\d+)\])?$/;

      for (let key in req.body) {
        const value = req.body[key];
        if (!value) continue;
        if (coreProgramPattern.test(key) && !result.coreProgram.includes(value)) {
          result.coreProgram.push(value);
        } else if (frontendPattern.test(key) && !result.frontend.includes(value)) {
          result.frontend.push(value);
        } else if (databasePattern.test(key) && !result.database.includes(value)) {
          result.database.push(value);
        }
      }
      return result;
    };

    const testConfigurationConfig = parseTestConfigurationConfig();
    console.log('Update - Parsed testConfiguration config:', JSON.stringify(testConfigurationConfig, null, 2));
    // ========== END ==========
    
    // Parse arrays from form data
    const parseArrayField = (fieldName) => {
      const values = [];
      for (let key in req.body) {
        if (key.startsWith(`${fieldName}[`) && key.endsWith(']')) {
          values.push(req.body[key]);
        }
      }
      if (req.body[fieldName] && Array.isArray(req.body[fieldName])) {
        return req.body[fieldName];
      }
      return values.length > 0 ? values : (req.body[fieldName] || []);
    };
    
    const courseHierarchy = parseArrayField('courseHierarchy');
    const I_Do = parseArrayField('I_Do');
    const We_Do = parseArrayField('We_Do');
    const You_Do = parseArrayField('You_Do');
    // Skilling engagements can target multiple batches (multi-select)
    const skillingBatches = parseArrayField('skillingBatches');
    // The course's own batch names from the mapping, as a JSON string. Stays
    // undefined when the caller omits the field — the undefined-strip pass
    // below then preserves whatever the record already holds, so callers that
    // predate this field (the legacy Add Course Structure popup) cannot wipe it.
    let courseBatches;
    if (req.body.batches !== undefined) {
      courseBatches = [];
      try {
        const parsed = typeof req.body.batches === 'string'
          ? JSON.parse(req.body.batches)
          : req.body.batches;
        if (Array.isArray(parsed)) {
          courseBatches = parsed.map((b) => String(b).trim()).filter(Boolean);
        }
      } catch { /* malformed JSON → clear rather than crash */ }
    }

    const {
      clientId,
      clientName,
      serviceType,
      serviceModal,
      category,
      courseCode,
      // The ServiceMapping this setup came from — must be whitelisted here or
      // strict mode silently drops it and mapping-scoped identity breaks.
      mappingId,
      // Bare like mappingId: an omitting caller yields undefined, which the
      // strip pass below removes, preserving whatever the record already holds.
      coursePath,
      // Same bare treatment: only callers that send the batch-content config
      // change it.
      batchResources,
      courseName,
      courseDescription,
      courseDuration,
      courseLevel,
      removeImage,
      aiChatGlobal,
      studentType,
      batch,
      degree,
    } = req.body;


    // Check if course exists
    const existingCourse = await CourseStructure.findById(courseId);
    if (!existingCourse) {
      return res.status(404).json({
        message: [{ key: "error", value: "Course not found" }],
      });
    }

    // Check if courseCode already exists (excluding current course).
    // Existence check only — no doc fields read.
    if (courseCode && courseCode !== existingCourse.courseCode) {
      const courseWithSameCode = await CourseStructure.findOne({
        courseCode,
        _id: { $ne: courseId }
      })
        .select("_id")
        .lean();
      if (courseWithSameCode) {
        return res.status(403).json({
          message: [{ key: "error", value: "Course Code already exists" }],
        });
      }
    }

    // Required fields check. Category is NOT required for Placement Training: a
    // placement course carries no category (its phase/name IS the course), so
    // requiring it rejected every placement course setup with "Required fields
    // are missing" even when the form was fully filled in.
    const categoryRequired = !/placement/i.test(String(serviceModal || ""));
    if (!clientId || !serviceType || !serviceModal || (categoryRequired && !category) || !courseName) {
      return res.status(400).json({
        message: [{ key: "error", value: "Required fields are missing" }],
      });
    }

    // Validate if clientId is a valid MongoDB ObjectId
    if (clientId && !mongoose.Types.ObjectId.isValid(clientId)) {
      return res.status(400).json({
        message: [{ key: "error", value: "Invalid client ID format" }],
      });
    }

    // Check if the client exists in Client Management (if client changed)
    let resolvedClientName = clientName || "";
    if (clientId && clientId !== (existingCourse.clientId ? existingCourse.clientId.toString() : "")) {
      const ClientManagement = mongoose.model("LMS-ClientManagement");
      const clientDoc = await ClientManagement.findById(clientId)
        .select("clientCompany")
        .lean();

      if (!clientDoc) {
        return res.status(404).json({
          message: [{ key: "error", value: "Client not found in the system" }],
        });
      }
      resolvedClientName = clientName || clientDoc.clientCompany || "";
    } else {
      // Client unchanged — keep the sent name or the existing one
      resolvedClientName = clientName || existingCourse.clientName || "";
    }

    // Parse departmentSections (nested array of { department, sections[], semesters[] })
    const parseDepartmentSections = () => {
      const byIndex = {};
      const deptPattern = /^departmentSections\[(\d+)\]\[department\]$/;
      const secPattern = /^departmentSections\[(\d+)\]\[sections\]\[(\d+)\]$/;
      const semPattern = /^departmentSections\[(\d+)\]\[semesters\]\[(\d+)\]$/;
      const ensure = (i) => (byIndex[i] = byIndex[i] || { department: "", sections: [], semesters: [] });
      for (const key in req.body) {
        const val = req.body[key];
        let m;
        if ((m = key.match(deptPattern))) {
          ensure(m[1]).department = val;
        } else if ((m = key.match(secPattern))) {
          ensure(m[1]).sections[parseInt(m[2], 10)] = val;
        } else if ((m = key.match(semPattern))) {
          ensure(m[1]).semesters[parseInt(m[2], 10)] = val;
        }
      }
      return Object.keys(byIndex)
        .sort((a, b) => Number(a) - Number(b))
        .map((i) => ({
          department: byIndex[i].department,
          sections: (byIndex[i].sections || []).filter(Boolean),
          semesters: (byIndex[i].semesters || []).filter(Boolean),
        }))
        .filter((d) => d.department || d.sections.length || d.semesters.length);
    };
    const departmentSections = parseDepartmentSections();

    // Multiple client-configuration blocks (sent as a JSON string)
    let clientConfigurations = [];
    try {
      const raw = req.body.clientConfigurations ? JSON.parse(req.body.clientConfigurations) : [];
      clientConfigurations = (Array.isArray(raw) ? raw : [])
        .map((c) => ({
          batch: String((c && c.batch) || "").trim(),
          degree: String((c && c.degree) || "").trim(),
          departments: (Array.isArray(c && c.departmentSections) ? c.departmentSections : (c && c.departments) || [])
            .map((d) => ({
              department: String((d && d.department) || "").trim(),
              sections: Array.isArray(d && d.sections) ? d.sections.map((s) => String(s).trim()).filter(Boolean) : [],
              semesters: Array.isArray(d && d.semesters) ? d.semesters.map((s) => String(s).trim()).filter(Boolean) : [],
            }))
            .filter((d) => d.department || d.sections.length || d.semesters.length),
        }))
        .filter((c) => c.batch || c.degree || c.departments.length);
    } catch (e) {
      clientConfigurations = [];
    }
    
    // Helper function to extract file data from various formats
    const extractFileData = (fileInput) => {
      let fileObj = fileInput;
      if (Array.isArray(fileInput)) {
        fileObj = fileInput[0];
      }
      
      if (!fileObj) return null;
      
      let fileData = null;
      let fileName = null;
      let mimeType = null;
      
      if (fileObj.data) {
        fileData = fileObj.data;
        fileName = fileObj.name || fileObj.originalname || 'image';
        mimeType = fileObj.mimetype || fileObj.type || 'image/jpeg';
      } 
      else if (fileObj.buffer) {
        fileData = fileObj.buffer;
        fileName = fileObj.originalname || fileObj.name || 'image';
        mimeType = fileObj.mimetype || fileObj.type || 'image/jpeg';
      }
      else if (fileObj.path) {
        const fs = require('fs');
        if (fs.existsSync(fileObj.path)) {
          fileData = fs.readFileSync(fileObj.path);
          fileName = fileObj.originalname || fileObj.name || 'image';
          mimeType = fileObj.mimetype || fileObj.type || 'image/jpeg';
        }
      }
      
      return fileData ? { fileData, fileName, mimeType } : null;
    };
    
    // Handle image upload/removal
    let imageUrl = existingCourse.courseImage;
    const imageFile = req.files?.courseImage;
    
    // If removeImage flag is true, remove the image
    if (removeImage === 'true') {
      imageUrl = undefined;
      console.log('Image removal requested');
      
      if (existingCourse.courseImage) {
        try {
          const oldImagePath = existingCourse.courseImage.split('/').pop();
          if (oldImagePath) {
            await supabase.storage.from("smartlms").remove([`course/image/${oldImagePath}`]);
            console.log('Old image deleted on removal:', oldImagePath);
          }
        } catch (deleteError) {
          console.error('Error deleting old image on removal:', deleteError);
        }
      }
    }
    
    // If new image is uploaded, upload it
    if (imageFile && removeImage !== 'true') {
      try {
        const extracted = extractFileData(imageFile);
        
        if (extracted) {
          const { fileData, fileName, mimeType } = extracted;
          
          console.log('Processing new image for update:', {
            fileName: fileName,
            fileSize: fileData.length,
            fileType: mimeType
          });
          
          if (fileData.length > 5 * 1024 * 1024) {
            return res.status(400).json({
              message: [{ key: "error", value: "Image size should be less than 5MB" }],
            });
          }
          
          const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
          if (!validTypes.includes(mimeType)) {
            return res.status(400).json({
              message: [{ key: "error", value: "Only JPEG, JPG, PNG, WebP, and GIF formats are allowed" }],
            });
          }
          
          const timestamp = Date.now();
          const baseFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
          const uniqueFileName = `${timestamp}_${baseFileName}`;
          
          console.log('Uploading new image to Supabase:', uniqueFileName);
          
          const { error: uploadError } = await supabase.storage
            .from("smartlms")
            .upload(`course/image/${uniqueFileName}`, fileData, {
              contentType: mimeType,
              cacheControl: '3600',
              upsert: false
            });
          
          if (uploadError) {
            console.error("Error uploading image to Supabase:", uploadError);
            return res.status(500).json({
              message: [{ key: "error", value: "Error uploading image to Supabase: " + uploadError.message }],
            });
          }
          
          const { data: publicUrlData } = supabase.storage
            .from("smartlms")
            .getPublicUrl(`course/image/${uniqueFileName}`);
          
          imageUrl = publicUrlData.publicUrl;
          console.log('New image URL generated:', imageUrl);
          
          // Delete old image if it exists
          if (existingCourse.courseImage) {
            try {
              const oldImagePath = existingCourse.courseImage.split('/').pop();
              if (oldImagePath) {
                await supabase.storage.from("smartlms").remove([`course/image/${oldImagePath}`]);
                console.log('Old image deleted:', oldImagePath);
              }
            } catch (deleteError) {
              console.error('Error deleting old image:', deleteError);
            }
          }
        }
      } catch (error) {
        console.error("Error processing image update:", error);
        imageUrl = existingCourse.courseImage;
      }
    }
    
    // Prepare update data
    const updateData = {
      clientId,
      clientName: resolvedClientName,
      serviceType,
      serviceModal,
      category,
      courseCode,
      // Left undefined when the caller omits it, so the undefined-stripping
      // pass below preserves whatever mappingId the record already has.
      mappingId,
      coursePath,
      // undefined when not sent (or unparseable) → stripped below, preserving
      // the stored config.
      batchResources: parseBatchResources(batchResources),
      courseName,
      courseDescription: courseDescription || "",
      courseDuration: courseDuration || "",
      courseLevel,
      aiChatGlobal: aiChatGlobal === 'true' || aiChatGlobal === true,
      studentType: studentType || "",
      batch: batch || "",
      degree: degree || "",
      departmentSections: departmentSections || [],
      clientConfigurations: clientConfigurations || [],
      skillingBatches: skillingBatches || [],
      // undefined when not sent → stripped below, preserving stored batches.
      batches: courseBatches,
      resourcesType: resourcesType,
      testConfiguration: testConfigurationConfig, // ADDED: Include testConfiguration in update
      courseHierarchy: courseHierarchy,
      I_Do: I_Do,
      We_Do: We_Do,
      You_Do: You_Do,
      updatedBy: req.user.email,
      updatedAt: new Date()
    };
    
    // Only update image if it was changed
    if (imageUrl !== existingCourse.courseImage) {
      updateData.courseImage = imageUrl;
    }
    
    // Remove undefined fields to avoid overwriting with undefined
    Object.keys(updateData).forEach(key => {
      if (updateData[key] === undefined) {
        delete updateData[key];
      }
    });
    
    // Update course
    const updatedCourse = await CourseStructure.findByIdAndUpdate(
      courseId,
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!updatedCourse) {
      return res.status(404).json({
        message: [{ key: "error", value: "Course not found" }],
      });
    }
    
    console.log("Course updated successfully:", {
      id: updatedCourse._id,
      courseName: updatedCourse.courseName,
      courseCode: updatedCourse.courseCode,
      hasImage: !!updatedCourse.courseImage,
      testConfiguration: updatedCourse.testConfiguration,
      resourcesType: {
        iDo: {
          video: { aiChat: updatedCourse.resourcesType.iDo.video?.aiChat, aiSummary: updatedCourse.resourcesType.iDo.video?.aiSummary },
          ppt: { aiChat: updatedCourse.resourcesType.iDo.ppt?.aiChat, aiSummary: updatedCourse.resourcesType.iDo.ppt?.aiSummary },
          pdf: { aiChat: updatedCourse.resourcesType.iDo.pdf?.aiChat, aiSummary: updatedCourse.resourcesType.iDo.pdf?.aiSummary }
        },
        weDo: {
          aiChat: updatedCourse.resourcesType.weDo.aiChat?.enabled,
          aiSummary: updatedCourse.resourcesType.weDo.aiSummary?.enabled,
          notes: updatedCourse.resourcesType.weDo.notes?.enabled
        },
        youDo: {
          aiChat: updatedCourse.resourcesType.youDo.aiChat?.enabled,
          aiSummary: updatedCourse.resourcesType.youDo.aiSummary?.enabled,
          notes: updatedCourse.resourcesType.youDo.notes?.enabled
        }
      }
    });
    
    return res.status(200).json({
      message: [{ key: "success", value: "Course structure updated successfully" }],
      data: updatedCourse,
    });
    
  } catch (error) {
    console.error("Error updating course structure:", error);
    return res.status(500).json({
      message: [{ key: "error", value: "Server error while updating course structure: " + error.message }],
    });
  }
};

exports.getCourseStructure = async (req, res) => {
  try {
    // ?summary=1 → listing projection: scalar fields + counts only, no
    // populated rosters, no groups, none of the heavy config subtrees. The
    // Course Setup workspace / service-mapping wizard / bulk-upload picker
    // read at most { _id, courseName, courseCode, clientId, clientName,
    // mappingId, coursePath, moduleCount, participantCount, hasModuleHours }
    // out of what was a multi-MB deep-populated payload. participantCount is
    // computed from raw user ObjectIds, which counts identically to the
    // populated path. Existing callers without the param are untouched.
    //
    // ?summary=enrolled → the same listing projection PLUS the two things a
    // per-user course list needs to decide visibility client-side: the roster
    // ids/statuses (kept, not stripped) and the service-mapping hierarchy
    // scalars (batch/degree/studentType/skillingBatches/departmentSections/
    // clientConfigurations) that courseMatchesUserHierarchy reads. Plain
    // ?summary=1 drops BOTH, so the grades pages cannot use it — they would
    // show every student zero courses. Measured on the wire, 68 courses:
    // full 348,390 B, summary=1 43,189 B, summary=enrolled 78,358 B.
    const summaryParam = String(req.query.summary || "");
    const summary =
      summaryParam === "1" ||
      summaryParam === "true" ||
      summaryParam === "enrolled";
    const withEnrollment = summaryParam === "enrolled";

    const courseStructures = summary
      ? await CourseStructure.find({ institution: req.user.institution })
          .select(
            "courseName courseCode courseImage clientId clientName mappingId coursePath " +
            "serviceType serviceModal category courseLevel courseDuration " +
            "status createdAt updatedAt institution approvalHierarchy " +
            "batchAndParticipants.users.user" +
            (withEnrollment
              ? " batchAndParticipants.users.status batch degree studentType " +
                "skillingBatches departmentSections clientConfigurations"
              : "")
          )
          .lean()
      : await CourseStructure.find({
          institution: req.user.institution,
        })
          .populate({
            path: 'batchAndParticipants.users.user',
            model: 'LMS-User',
            populate: {
              path: 'role',
              model: 'Role', // Make sure this matches your Role model name
              select: 'originalRole renameRole' // Select role fields you need
            },
            select: 'name email role status profileImage' // User fields
          })
          .populate('groups')
          .lean();

    // Three independent lookups. Serialized they add up on the heaviest
    // endpoint the wizard touches; Promise.all cuts them to one RTT.
    const PedagogyView = require("../../models/Courses/moduleStructure/pedagogyViewModal");
    const { findDefaultApproverRole } = require("../../utils/approvalWorkflow");
    const courseIds = courseStructures.map((c) => c._id);
    const durationsOf = (field) => ({
      $sum: {
        $map: {
          input: { $ifNull: [field, []] },
          as: "a",
          in: { $ifNull: ["$$a.duration", 0] },
        },
      },
    });
    // Approvals UI: a course without its own approvalHierarchy falls back to
    // the institution's L&D role — but only if that role exists. Tell views
    // its name (or null) instead of letting them hardcode "L&D (default)".
    // Non-critical — swallow errors so the whole endpoint doesn't 500.
    const [moduleCounts, hourTotals, defaultApprover] = await Promise.all([
      Module1.aggregate([
        { $match: { courses: { $in: courseIds } } },
        { $group: { _id: "$courses", count: { $sum: 1 } } },
      ]),
      PedagogyView.aggregate([
        { $match: { courses: { $in: courseIds } } },
        { $unwind: "$pedagogies" },
        {
          $project: {
            courses: 1,
            t: {
              $add: [
                durationsOf("$pedagogies.iDo"),
                durationsOf("$pedagogies.weDo"),
                durationsOf("$pedagogies.youDo"),
              ],
            },
          },
        },
        { $group: { _id: "$courses", total: { $sum: "$t" } } },
      ]),
      findDefaultApproverRole(req.user.institution).catch(() => null),
    ]);
    const moduleCountByCourse = new Map(
      moduleCounts.map((m) => [m._id.toString(), m.count])
    );
    const hoursByCourse = new Map(
      hourTotals.map((h) => [h._id.toString(), h.total || 0])
    );

    // Summary mode skips populate, so a roster entry pointing at a DELETED
    // user still carries its raw ObjectId — the populated path nulls those
    // out and never counts them. One id-only existence query keeps the
    // participantCount semantics identical (verified live: without this the
    // counts differ on courses with dangling refs).
    let existingUserIds = null;
    if (summary) {
      const allIds = new Set();
      courseStructures.forEach((c) =>
        (c.batchAndParticipants || []).forEach((b) =>
          (b.users || []).forEach((u) => {
            const id = u && u.user;
            if (id) allIds.add(String(id));
          })
        )
      );
      const found = allIds.size
        ? await User.find({ _id: { $in: [...allIds] } }).select("_id").lean()
        : [];
      existingUserIds = new Set(found.map((u) => String(u._id)));
    }

    // clientName is stored as the readable company name; clientId references
    // the Client Management client. Attach the module count, the enrolled
    // count, and whether pedagogy hours exist — counted here, in the same
    // pass that already populates batchAndParticipants, so the client doesn't
    // have to walk every batch.
    // Distinct by user id: a student sitting two batches is one participant.
    const populatedCourses = courseStructures.map((course) => {
      const moduleCount = moduleCountByCourse.get(course._id.toString()) || 0;
      const seen = new Set();
      (course.batchAndParticipants || []).forEach((b) => {
        (b.users || []).forEach((u) => {
          const id = u && u.user && (u.user._id || u.user);
          if (!id) return;
          const idStr = String(id);
          if (existingUserIds && !existingUserIds.has(idStr)) return;
          seen.add(idStr);
        });
      });
      // Summary rows drop the roster array once it has been counted —
      // except in `enrolled` mode, where the roster IS the payload's reason
      // for existing (the caller filters courses by "am I in this batch?").
      const base =
        summary && !withEnrollment
          ? (({ batchAndParticipants, ...rest }) => rest)(course)
          : course;
      return {
        ...base,
        moduleCount,
        participantCount: seen.size,
        defaultApproverRole: defaultApprover ? defaultApprover.roleName : null,
        // The Program Calendar's gate: at least one module AND hours entered.
        hasModuleHours:
          moduleCount > 0 && (hoursByCourse.get(course._id.toString()) || 0) > 0,
      };
    });

    return res.status(200).json({
      message: [
        { key: "success", value: "Course structures retrieved successfully" },
      ],
      data: populatedCourses,
    });
  } catch (error) {
    console.error("Error fetching course structures:", error);
    return res.status(500).json({
      message: [
        {
          key: "error",
          value: "Server error while fetching course structures",
        },
      ],
    });
  }
};


exports.getAllCoursesDataWithoutAINotes = async (req, res) => {
  try {

    // Find the course with participants and complete user data
 const course = await CourseStructure.find({
      institution: req.user.institution,
    }).populate({
        path: 'batchAndParticipants.users.user',
        select: '-notes -ai_history -password -tokens -__v -notifications',
        populate: [
          {
            path: 'role',
            select: 'name description'
          },
          {
            path: 'courses.courseId',
            select: 'courseName courseCode description'
          }
        ]
      })
      .lean();

    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Course not found"
      });
    }

    // Flatten users across all batches of every course
    const allBatchUsers = course.flatMap(c =>
      (c.batchAndParticipants || []).flatMap(batch =>
        (batch.users || []).map(batchUser => ({
          ...batchUser,
          batchId: batch._id,
          batchName: batch.batchName,
        }))
      )
    );

    // Get complete course progress for all participants
    const participantsWithFullData = await Promise.all(
      allBatchUsers.map(async (participant) => {
        if (!participant.user) {
          return {
            ...participant,
            user_Data: null
          };
        }

        // Get the complete course progress data for this specific course
        const user = await User.findById(participant.user._id)
          .select('courses')
          .lean();

        // Find the full course progress for this specific course
        const fullCourseProgress = user?.courses?.find(
          course => course.courseId && course.courseId.toString() === course
        );

        // Merge the basic user data with complete course progress
        const userData = {
          ...participant.user,
          courses: fullCourseProgress ? [fullCourseProgress] : []
        };

        // Clean up the data
        const cleanUserData = JSON.parse(JSON.stringify(userData, (key, value) => {
          // Remove unwanted fields
          if (key === 'notes' || key === 'ai_history' || key === 'password' || 
              key === 'tokens' || key === '__v' || key === '$__' || 
              key === '$isNew' || value === undefined) {
            return undefined;
          }
          return value;
        }));

        return {
          _id: participant._id,
          status: participant.status,
          batchId: participant.batchId,
          batchName: participant.batchName,
          joinedAt: participant.joinedAt,
          updatedAt: participant.updatedAt,
          user_Data: cleanUserData
        };
      })
    );

    // Fetch course structure components
    const [modules, subModules, topics, subTopics] = await Promise.all([
      Module1.find({ courses: course }).select('-__v -createdAt -updatedAt').lean(),
      SubModule1.find({ moduleId: { $in: await Module1.find({ courses: course }).distinct('_id') } })
        .select('-__v -createdAt -updatedAt').lean(),
      Topic1.find({
        $or: [
          { moduleId: { $in: await Module1.find({ courses: course }).distinct('_id') } },
          { subModuleId: { $in: await SubModule1.find().distinct('_id') } }
        ]
      }).select('-__v -createdAt -updatedAt').lean(),
      SubTopic1.find({ 
        topicId: { $in: await Topic1.find().distinct('_id') } 
      }).select('-__v -createdAt -updatedAt').lean()
    ]);

    // Structure modules with their relationships
    const structuredModules = modules.map(module => {
      const moduleSubModules = subModules.filter(
        sm => sm.moduleId?.toString() === module._id.toString()
      );

      const processedSubModules = moduleSubModules.map(subModule => {
        const subModuleTopics = topics.filter(
          t => t.subModuleId?.toString() === subModule._id.toString()
        );

        const processedTopics = subModuleTopics.map(topic => ({
          ...topic,
          subTopics: subTopics.filter(
            st => st.topicId?.toString() === topic._id.toString()
          )
        }));

        return {
          ...subModule,
          topics: processedTopics
        };
      });

      const moduleDirectTopics = topics.filter(
        t =>
          t.moduleId?.toString() === module._id.toString() &&
          (!t.subModuleId || !moduleSubModules.some(sm => sm._id.toString() === t.subModuleId?.toString()))
      );

      const processedDirectTopics = moduleDirectTopics.map(topic => ({
        ...topic,
        subTopics: subTopics.filter(
          st => st.topicId?.toString() === topic._id.toString()
        )
      }));

      return {
        ...module,
        subModules: processedSubModules,
        topics: processedDirectTopics
      };
    });

    // Construct final response
    const responseData = {
      _id: course._id,
      courseName: course.courseName,
      courseCode: course.courseCode,
      description: course.description,
      participants: participantsWithFullData,
      modules: structuredModules,
      meta: {
        participantsCount: participantsWithFullData.length,
        modulesCount: modules.length,
        subModulesCount: subModules.length,
        topicsCount: topics.length,
        subTopicsCount: subTopics.length
      }
    };

    res.status(200).json({
      success: true,
      data: responseData,
      message: "Course data with complete user progress fetched successfully"
    });

  } catch (error) {
    console.error("Error fetching course structure:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
};
exports.getCourseStructureById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: [{ key: "error", value: "Invalid course ID format" }],
      });
    }

    // .lean() — read-only path; hydrating a large-roster course doc just to
    // call .toObject() on it was pure overhead.
    const courseStructure = await CourseStructure.findOne({
      _id: id,
      institution: req.user.institution,
    }).lean();

    if (!courseStructure) {
      return res.status(404).json({
        message: [{ key: "error", value: "Course structure not found" }],
      });
    }

    // clientId references the Client Management client; clientName is the
    // stored readable name. Backfill the name if an older doc is missing it.
    let populatedCourse = courseStructure;

    if (populatedCourse.clientId && !populatedCourse.clientName) {
      try {
        const ClientManagement = mongoose.model("LMS-ClientManagement");
        const clientDoc = await ClientManagement.findById(populatedCourse.clientId).lean();
        if (clientDoc) populatedCourse.clientName = clientDoc.clientCompany;
      } catch (e) {
        // best-effort backfill only
      }
    }

    return res.status(200).json({
      message: [
        { key: "success", value: "Course structure retrieved successfully" },
      ],
      data: populatedCourse,
    });
  } catch (error) {
    console.error("Error fetching course structure by ID:", error);
    return res.status(500).json({
      message: [
        { key: "error", value: "Server error while fetching course structure" },
      ],
    });
  }
};
;

exports.deleteCourseStructure = async (req, res) => {
  try {
    const { id } = req.params;

    // Validate if ID is a valid MongoDB ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: [{ key: "error", value: "Invalid course ID format" }],
      });
    }

    // Find the existing course
    const existingCourse = await CourseStructure.findOne({
      _id: id,
      institution: req.user.institution,
    });

    if (!existingCourse) {
      return res.status(404).json({
        message: [{ key: "error", value: "Course structure not found" }],
      });
    }

    // Delete the associated image from Supabase (if it's not a default image)
    if (
      existingCourse.courseImage &&
      !existingCourse.courseImage.includes("default_profile_image")
    ) {
      try {
        const imagePath = existingCourse.courseImage.split("/").pop();
        const { error: deleteError } = await supabase.storage
          .from("smartlms")
          .remove([`course/image/${imagePath}`]);

        if (deleteError) {
          console.error("Error deleting image from Supabase:", deleteError);
          // Don't return error here, continue with course deletion
        }
      } catch (deleteErr) {
        console.error("Error extracting image path for deletion:", deleteErr);
        // Don't return error here, continue with course deletion
      }
    }

    // Delete the course AND everything under it — module/topic trees, pedagogy
    // and level views, exams, answers, live questions, retests, calendars,
    // schedules, attendance, groups, feedback, activity logs, workspaces, and
    // each user's embedded enrolment/progress entry. Previously only the course
    // doc was removed and all of that was orphaned. Image cleanup already
    // happened above, so the cascade skips it; the surviving mapping's
    // courseId/courseCode back-pointer is blanked.
    const cascade = await cascadeDeleteCourses([id], {
      clearMappingBackPointer: true,
      deleteImages: false,
    });

    return res.status(200).json({
      message: [
        { key: "success", value: "Course structure deleted successfully" },
      ],
      cascade,
    });
  } catch (error) {
    console.error("Error deleting course structure:", error);
    return res.status(500).json({
      message: [
        { key: "error", value: "Server error while deleting course structure" },
      ],
    });
  }
};
exports.batchAddParticipants = async (req, res) => {
  try {
    const { courseId } = req.params;
    const {
      participantIds,
      batchName,
      batchDescription,
      batchStartDate,
      batchEndDate,
      status = 'active', // Optional user status, default to 'active'
      // Hierarchy node the participants are being added at (all optional)
      degree = '',
      department = '',
      section = '',
      semester = '',
    } = req.body;
 
    // Validate input - Make participantIds optional for batch creation
    if (participantIds && (!Array.isArray(participantIds) || participantIds.length === 0)) {
      return res.status(400).json({
        success: false,
        message: 'participantIds must be a non-empty array'
      });
    }
 
    if (!batchName) {
      return res.status(400).json({
        success: false,
        message: 'Please provide batch name'
      });
    }
 
    // Find the course
    const course = await CourseStructure.findById(courseId);
 
    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }
 
    // Initialize batchAndParticipants if it doesn't exist
    if (!course.batchAndParticipants) {
      course.batchAndParticipants = [];
    }
 
    // BATCH HANDLING: Find or create batch in batchAndParticipants
    let targetBatch = null;
    let isNewBatch = false;
    let batchIndex = -1;
 
    // Check if batch already exists in batchAndParticipants
    if (course.batchAndParticipants && course.batchAndParticipants.length > 0) {
      batchIndex = course.batchAndParticipants.findIndex(
        batch => batch.batchName && batch.batchName.toLowerCase() === batchName.toLowerCase()
      );
    }
 
    if (batchIndex !== -1) {
      // Batch exists, get reference
      targetBatch = course.batchAndParticipants[batchIndex];
    } else {
      // Create new batch with start and end dates
      isNewBatch = true;
      targetBatch = {
        batchName: batchName.trim(),
        batchDescription: batchDescription || '',
        batchStartDate: batchStartDate || null,
        batchEndDate: batchEndDate || null,
        users: [],
        status: 'active',
        createdAt: new Date(),
        createdBy: req.user?.id || 'system',
        updatedAt: new Date(),
        updatedBy: req.user?.id || 'system'
      };
      course.batchAndParticipants.push(targetBatch);
      batchIndex = course.batchAndParticipants.length - 1;
    }
 
    // If no participantIds provided, just create/return the batch
    if (!participantIds || participantIds.length === 0) {
      // Save the course with the new batch
      await course.save();
 
      // Fetch updated course to get all batches
      const updatedCourse = await CourseStructure.findById(courseId);
     
      // Format batches as named objects
      const formattedBatches = {};
      if (updatedCourse.batchAndParticipants) {
        updatedCourse.batchAndParticipants.forEach((batch, index) => {
          formattedBatches[index] = batch.batchName;
        });
      }
 
      return res.status(200).json({
        success: true,
        message: isNewBatch ? 'Batch created successfully' : 'Batch already exists',
        data: {
          batches: formattedBatches,
          batchInfo: {
            batchName: targetBatch.batchName,
            batchDescription: targetBatch.batchDescription,
            batchStartDate: targetBatch.batchStartDate,
            batchEndDate: targetBatch.batchEndDate,
            isNewBatch: isNewBatch,
            totalUsersInBatch: targetBatch.users ? targetBatch.users.length : 0,
            batchId: targetBatch._id
          }
        }
      });
    }
 
    // Enrollment must fail loudly, never partially: a malformed or stale id
    // silently dropped here means a person silently missing from a batch,
    // discovered weeks later in attendance. Reject the whole request and
    // name the offending ids instead.
    const uniqueParticipantIds = [...new Set(participantIds.map(String))];
    const malformedIds = uniqueParticipantIds.filter(
      (id) => !mongoose.Types.ObjectId.isValid(id)
    );
    if (malformedIds.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Invalid participant id(s): ${malformedIds.join(', ')}`
      });
    }

    // Projection covers every field this handler reads (name/email/role +
    // the hierarchy defaults) — the unprojected find hydrated each student's
    // full doc including courses/notifications/ai_history, MB-scale for a
    // large enrollment batch.
    const participants = await User.find({
      _id: { $in: uniqueParticipantIds }
    })
      .select("firstName lastName email role degree department section semester")
      .lean();

    if (participants.length !== uniqueParticipantIds.length) {
      const foundIds = new Set(participants.map((p) => String(p._id)));
      const missingIds = uniqueParticipantIds.filter((id) => !foundIds.has(id));
      return res.status(400).json({
        success: false,
        message: `No user exists for participant id(s): ${missingIds.join(', ')}`
      });
    }
 
    // A STUDENT belongs to exactly ONE batch of a course — someone already
    // sitting in a different batch must not be enrolled into this one (the
    // client's picker hides them; this is the backstop). Staff are exempt:
    // a trainer serves several batches, and attendance's role scoping counts
    // on that membership. Reference-compare against targetBatch so a NEW
    // batch (not yet in the array) treats every existing batch as "other".
    const otherBatchMemberIds = new Set();
    (course.batchAndParticipants || []).forEach((b) => {
      if (b === targetBatch) return;
      (b.users || []).forEach((u) => {
        const id = u && u.user && (u.user._id || u.user);
        if (id) otherBatchMemberIds.add(String(id));
      });
    });
    // Roles arrive as a Role reference on newer users and a plain role-name
    // string on legacy ones — resolve both shapes, one query.
    const participantRoleIds = [...new Set(
      participants
        .map((p) => String(p.role || ""))
        .filter((v) => v && mongoose.Types.ObjectId.isValid(v))
    )];
    const participantRoleDocs = participantRoleIds.length
      ? await Role.find({ _id: { $in: participantRoleIds } })
          .select("originalRole renameRole")
          .lean()
      : [];
    const roleNameById = new Map(
      participantRoleDocs.map((r) => [
        String(r._id),
        String(r.originalRole || r.renameRole || "").toLowerCase(),
      ])
    );
    const isStudentParticipant = (p) => {
      const raw = String(p.role || "");
      const name =
        roleNameById.get(raw) ||
        (raw && !mongoose.Types.ObjectId.isValid(raw) ? raw.toLowerCase() : "");
      return name === "student";
    };

    // Prepare users to add - Simplified without enrollment dates
    const usersToAdd = [];
    const addedUsersList = [];
    const skippedOtherBatch = [];

    for (const participant of participants) {
      // Check if participant already exists in this batch
      const userExists = targetBatch.users && targetBatch.users.some(
        user => user.user && user.user.toString() === participant._id.toString()
      );

      if (
        !userExists &&
        otherBatchMemberIds.has(participant._id.toString()) &&
        isStudentParticipant(participant)
      ) {
        skippedOtherBatch.push(
          `${participant.firstName || ""} ${participant.lastName || ""}`.trim() ||
            participant.email ||
            String(participant._id)
        );
        continue;
      }

      if (!userExists) {
        // Prepare user object for the batch - with hierarchy context
        const userObj = {
          user: participant._id,
          status: status || 'active',
          degree: degree || participant.degree || '',
          department: department || participant.department || '',
          section: section || participant.section || '',
          semester: semester || participant.semester || '',
          joinedAt: new Date(),
          updatedAt: new Date()
        };
 
        usersToAdd.push(userObj);
        addedUsersList.push({
          id: participant._id,
          name: `${participant.firstName} ${participant.lastName || ''}`.trim(),
          email: participant.email
        });
      }
    }
 
    if (usersToAdd.length === 0) {
      // Fetch updated course to get all batches
      const updatedCourse = await CourseStructure.findById(courseId);
     
      // Format batches as named objects
      const formattedBatches = {};
      if (updatedCourse.batchAndParticipants) {
        updatedCourse.batchAndParticipants.forEach((batch, index) => {
          formattedBatches[index] = batch.batchName;
        });
      }
 
      return res.status(200).json({
        success: true,
        message: skippedOtherBatch.length
          ? `Not enrolled: ${skippedOtherBatch.join(', ')} ${skippedOtherBatch.length === 1 ? 'is' : 'are'} already in another batch of this course — a student belongs to one batch`
          : 'All selected participants are already enrolled in this batch',
        data: {
          batches: formattedBatches,
          batchInfo: {
            batchName: targetBatch.batchName,
            batchDescription: targetBatch.batchDescription,
            batchStartDate: targetBatch.batchStartDate,
            batchEndDate: targetBatch.batchEndDate,
            isNewBatch: isNewBatch,
            totalUsersInBatch: targetBatch.users ? targetBatch.users.length : 0,
            batchId: targetBatch._id
          }
        }
      });
    }
 
    // Add users to the batch
    if (!targetBatch.users) {
      targetBatch.users = [];
    }
    targetBatch.users.push(...usersToAdd);
    targetBatch.updatedAt = new Date();
    targetBatch.updatedBy = req.user?.id || 'system';
   
    // Update the batch in the array
    if (batchIndex !== -1) {
      course.batchAndParticipants[batchIndex] = targetBatch;
    } else {
      course.batchAndParticipants.push(targetBatch);
    }
 
    course.updatedAt = new Date();
    course.updatedBy = req.user?.id || 'system';
 
    // Save the course
    await course.save();
 
    // Fetch updated course to get all batches. Only the roster array is
    // read by the response formatter below — no need to rehydrate the whole
    // course doc with its config subtrees.
    const updatedCourse = await CourseStructure.findById(courseId)
      .select('batchAndParticipants')
      .populate({
        path: 'batchAndParticipants.users.user',
        select: 'firstName lastName email'
      })
      .lean();
 
    // Format batches as named objects with user details
    const formattedBatches = {};
    if (updatedCourse.batchAndParticipants) {
      updatedCourse.batchAndParticipants.forEach((batch, index) => {
        formattedBatches[index] = {
          batchName: batch.batchName,
          batchDescription: batch.batchDescription,
          batchStartDate: batch.batchStartDate,
          batchEndDate: batch.batchEndDate,
          totalUsers: batch.users ? batch.users.length : 0,
          users: batch.users ? batch.users.map(user => ({
            id: user.user?._id || user.user,
            name: user.user ? `${user.user.firstName || ''} ${user.user.lastName || ''}`.trim() : 'Unknown',
            email: user.user?.email || 'N/A',
            status: user.status || 'active',
            joinedAt: user.joinedAt
          })) : []
        };
      });
    }
 
    // Also format simple batch names for quick reference
    const batchNames = {};
    if (updatedCourse.batchAndParticipants) {
      updatedCourse.batchAndParticipants.forEach((batch, index) => {
        batchNames[index] = batch.batchName;
      });
    }
 
    // Return response with batch info and added participants
    res.status(200).json({
      success: true,
      message: (isNewBatch
        ? `Batch "${batchName}" created with ${usersToAdd.length} participant(s)`
        : `${usersToAdd.length} participant(s) added successfully to batch "${batchName}"`)
        + (skippedOtherBatch.length
          ? `. Skipped ${skippedOtherBatch.join(', ')} — already in another batch of this course`
          : ''),
      data: {
        allBatches: batchNames,
        batchDetails: formattedBatches,
        targetBatch: {
          batchName: targetBatch.batchName,
          batchDescription: targetBatch.batchDescription,
          batchStartDate: targetBatch.batchStartDate,
          batchEndDate: targetBatch.batchEndDate,
          isNewBatch: isNewBatch,
          totalUsersInBatch: targetBatch.users ? targetBatch.users.length : 0,
          batchId: targetBatch._id
        },
        addedParticipants: addedUsersList,
        totalAdded: usersToAdd.length,
        alreadyEnrolled:
          participants.length - usersToAdd.length - skippedOtherBatch.length,
        // Students refused because they already sit in another batch of this
        // course — named so the client can say exactly who and why.
        skippedOtherBatch,
      }
    });
 
  } catch (error) {
    console.error('Error adding participants:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add participants',
      error: error.message
    });
  }
};
 
// GET /courses/:courseId/batches — lightweight list for the Batches page
//
// Batches are DEFINED on the client (Dynamic Field Settings → Client) and
// picked at course creation (course.batch for degree-program /
// course.skillingBatches for skilling). This endpoint auto-creates a
// batchAndParticipants entry for every picked batch that doesn't have one
// yet, so the page always lists the client's batches without a manual
// "Add batch" step. Only the schedule dates / description / status are
// editable afterwards — never the name.
exports.getCourseBatches = async (req, res) => {
  try {
    const { courseId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(courseId)) {
      return res.status(400).json({ success: false, message: "Invalid courseId" });
    }

    const course = await CourseStructure.findById(courseId)
      // mappingId is here so the Course Participants page can build its
      // breadcrumb from this one response. It used to pull the entire course
      // from /getAll/courses-data/:courseId — 896 KB of modules, pedagogy
      // trees and fully-populated enrolled users — to read three strings.
      .select("courseName courseCode mappingId batchAndParticipants studentType batch skillingBatches batches degree departmentSections clientConfigurations");

    if (!course) {
      return res.status(404).json({ success: false, message: "Course not found" });
    }

    // Effective type — fall back to the course's actual data when studentType
    // wasn't stored (older courses / courses created before the type was set).
    const hasDegreeData =
      !!course.degree || (course.departmentSections || []).length > 0;
    const effectiveStudentType =
      course.studentType ||
      (hasDegreeData
        ? "degree-program"
        : (course.skillingBatches || []).length > 0
          ? "skilling"
          : "");

    // Batch names picked from the client at course creation. Pull from the
    // single batch, the skilling batches AND the course's own mapping batches
    // (Degree Program per-course b1/b2…) so a batch always shows when set,
    // regardless of whether studentType was stored.
    const pickedNames = Array.from(
      new Set(
        [course.batch, ...(course.skillingBatches || []), ...(course.batches || [])]
          .map((n) => (n || "").trim())
          .filter(Boolean)
      )
    );

    const existingNames = new Set(
      (course.batchAndParticipants || []).map((b) => (b.batchName || "").trim().toLowerCase())
    );
    const missing = pickedNames.filter((n) => !existingNames.has(n.toLowerCase()));

    let mutated = false;
    if (missing.length > 0) {
      missing.forEach((batchName) => {
        course.batchAndParticipants.push({
          batchName,
          batchDescription: "",
          batchStartDate: null,
          batchEndDate: null,
          status: "active",
          users: [],
          ...(req.user?.id ? { createdBy: req.user.id } : {}),
        });
      });
      mutated = true;
    }

    // A course with REAL batch names has no use for the "Default" container —
    // it only exists because someone enrolled before the batches reached the
    // record (the enrol falls back to 'Default' when no batch is open). Its
    // users are absorbed into the first real batch rather than deleted, so no
    // enrolment is lost, and the empty container is dropped from the tabs.
    // Skipped when 'Default' is itself a picked name — then it is a real batch.
    if (pickedNames.length > 0 && !pickedNames.some((n) => n.toLowerCase() === "default")) {
      const defaultIdx = (course.batchAndParticipants || []).findIndex(
        (b) => (b.batchName || "").trim().toLowerCase() === "default"
      );
      if (defaultIdx !== -1) {
        const fallback = course.batchAndParticipants[defaultIdx];
        const target = course.batchAndParticipants.find(
          (b) => (b.batchName || "").trim().toLowerCase() === pickedNames[0].toLowerCase()
        );
        if (target) {
          if (!Array.isArray(target.users)) target.users = [];
          const present = new Set(target.users.map((u) => String(u.user)));
          (fallback.users || []).forEach((u) => {
            if (!present.has(String(u.user))) target.users.push(u);
          });
          target.updatedAt = new Date();
          course.batchAndParticipants.splice(defaultIdx, 1);
          mutated = true;
        }
      }
    }

    if (mutated) {
      course.updatedAt = new Date();
      await course.save();
    }

    const batches = (course.batchAndParticipants || []).map((batch) => ({
      _id: batch._id,
      batchName: batch.batchName,
      batchDescription: batch.batchDescription || "",
      batchStartDate: batch.batchStartDate,
      batchEndDate: batch.batchEndDate,
      status: batch.status || "active",
      enrolledCount: batch.users ? batch.users.length : 0,
      // Whether the REQUESTER is enrolled in this batch. Batch-membership is
      // what scopes a non-admin everywhere (attendance, and the calendar's
      // deviation question) — sent here so callers don't need the full
      // participant payload just to know their own batches.
      mine: (batch.users || []).some(
        (u) => String(u?.user?._id || u?.user || "") === String(req.user?._id || "")
      ),
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
    }));

    res.status(200).json({
      success: true,
      data: {
        courseId: course._id,
        courseName: course.courseName,
        courseCode: course.courseCode || "",
        mappingId: course.mappingId || "",
        // Client type drives the manage-participants flow: degree-program
        // courses drill into the hierarchy first, skilling goes straight to users.
        studentType: effectiveStudentType,
        // Hierarchy data: batch → degree → department → (sections, semesters per dept)
        degree: course.degree || "",
        departmentSections: (course.departmentSections || []).map((d) => ({
          department: d.department || "",
          sections: (d.sections || []).map((s) => (s || "").trim()).filter(Boolean),
          semesters: (d.semesters || []).map((s) => (s || "").trim()).filter(Boolean),
        })),
        clientConfigurations: course.clientConfigurations || [],
        batches,
      },
    });
  } catch (error) {
    console.error("Error fetching course batches:", error);
    res.status(500).json({ success: false, message: "Failed to fetch batches", error: error.message });
  }
};

// PUT /courses/:courseId/batches/:batchId — edit batch details
exports.updateBatch = async (req, res) => {
  try {
    const { courseId, batchId } = req.params;
    const { batchName, batchDescription, batchStartDate, batchEndDate, status } = req.body;

    if (!mongoose.Types.ObjectId.isValid(courseId) || !mongoose.Types.ObjectId.isValid(batchId)) {
      return res.status(400).json({ success: false, message: "Invalid courseId or batchId" });
    }

    const course = await CourseStructure.findById(courseId);
    if (!course) {
      return res.status(404).json({ success: false, message: "Course not found" });
    }

    const batch = (course.batchAndParticipants || []).find(
      (b) => b._id.toString() === batchId
    );
    if (!batch) {
      return res.status(404).json({ success: false, message: "Batch not found" });
    }

    // Batch names identify batches in the add-participants flow — keep them unique.
    if (batchName && batchName.trim()) {
      const duplicate = course.batchAndParticipants.some(
        (b) =>
          b._id.toString() !== batchId &&
          b.batchName &&
          b.batchName.toLowerCase() === batchName.trim().toLowerCase()
      );
      if (duplicate) {
        return res.status(400).json({ success: false, message: "A batch with this name already exists" });
      }
      batch.batchName = batchName.trim();
    }
    if (batchDescription !== undefined) batch.batchDescription = batchDescription;
    if (batchStartDate !== undefined) batch.batchStartDate = batchStartDate || null;
    if (batchEndDate !== undefined) batch.batchEndDate = batchEndDate || null;
    if (status) batch.status = status;
    batch.updatedAt = new Date();
    if (req.user?.id) batch.updatedBy = req.user.id;

    course.updatedAt = new Date();
    await course.save();

    res.status(200).json({ success: true, message: "Batch updated successfully", data: batch });
  } catch (error) {
    console.error("Error updating batch:", error);
    res.status(500).json({ success: false, message: "Failed to update batch", error: error.message });
  }
};

// DELETE /courses/:courseId/batches/:batchId — remove a batch (and its enrolments)
exports.deleteBatch = async (req, res) => {
  try {
    const { courseId, batchId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(courseId) || !mongoose.Types.ObjectId.isValid(batchId)) {
      return res.status(400).json({ success: false, message: "Invalid courseId or batchId" });
    }

    const course = await CourseStructure.findById(courseId);
    if (!course) {
      return res.status(404).json({ success: false, message: "Course not found" });
    }

    const before = (course.batchAndParticipants || []).length;
    course.batchAndParticipants = (course.batchAndParticipants || []).filter(
      (b) => b._id.toString() !== batchId
    );

    if (course.batchAndParticipants.length === before) {
      return res.status(404).json({ success: false, message: "Batch not found" });
    }

    course.updatedAt = new Date();
    if (req.user?.email) course.updatedBy = req.user.email;
    await course.save();

    res.status(200).json({ success: true, message: "Batch deleted successfully" });
  } catch (error) {
    console.error("Error deleting batch:", error);
    res.status(500).json({ success: false, message: "Failed to delete batch", error: error.message });
  }
};

exports.updateParticipantEnrollment = async (req, res) => {
  try {
    const { courseId, participantId } = req.params;
    const { status, batchId } = req.body;

    // Validate at least one field is provided
    if (!status) {
      return res.status(400).json({
        success: false,
        message: 'Please provide at least one field to update'
      });
    }

    // Find the course
    const course = await CourseStructure.findById(courseId);

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // Find the participant inside the batches and update their status.
    // If batchId is provided, only that batch is touched; otherwise the
    // participant is updated in every batch they appear in.
    let participantFound = false;
    (course.batchAndParticipants || []).forEach(batch => {
      if (batchId && batch._id.toString() !== batchId.toString()) return;
      (batch.users || []).forEach(batchUser => {
        if (batchUser.user && batchUser.user.toString() === participantId) {
          batchUser.status = status;
          batchUser.updatedAt = new Date();
          batch.updatedAt = new Date();
          participantFound = true;
        }
      });
    });

    if (!participantFound) {
      return res.status(404).json({
        success: false,
        message: 'Participant not found in this course'
      });
    }

    // Save the updated course
    course.updatedAt = new Date();
    course.updatedBy = req.user?.id || 'system';
    await course.save();

    // Populate user details for response
    const populatedCourse = await CourseStructure.findById(courseId)
      .populate({
        path: 'batchAndParticipants.users.user',
        select: 'firstName lastName email phone role status degree department year semester batch gender profile createdAt'
      });

    res.status(200).json({
      success: true,
      message: 'Enrollment updated successfully',
      data: populatedCourse
    });

  } catch (error) {
    console.error('Error updating enrollment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update enrollment',
      error: error.message
    });
  }
};


// Backend API - Remove participant from course
exports.deleteAddParticipants = async (req, res) => {
  try {
    const { courseId, userId } = req.params;

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID format'
      });
    }

    // Find the course
    const course = await CourseStructure.findById(courseId);

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // Check if course has batches with participants
    if (!course.batchAndParticipants || !Array.isArray(course.batchAndParticipants)) {
      return res.status(404).json({
        success: false,
        message: 'No participants found in this course'
      });
    }

    // Optional batch scoping: when batchId is given, only that batch is
    // searched/modified — the user keeps their enrolment in other batches.
    const { batchId } = req.query;

    // Find the participant in any (matching) batch
    let participantId = null;

    for (const batch of course.batchAndParticipants) {
      if (batchId && batch._id.toString() !== batchId) continue;
      const found = (batch.users || []).find(
        batchUser => batchUser.user && batchUser.user.toString() === userId
      );
      if (found) {
        participantId = found.user.toString();
        break;
      }
    }

    if (!participantId) {
      return res.status(404).json({
        success: false,
        message: 'Participant not found in this course'
      });
    }

    // Get participant details before removal - DON'T use .select() to preserve schema methods
    const participant = await User.findById(participantId);
    // Alternative: Use lean() if you need specific fields but still want to call methods
    // const participant = await User.findById(participantId).lean();

    if (!participant) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Remove the participant from every matching batch they appear in
    let removedFromBatches = 0;
    course.batchAndParticipants.forEach(batch => {
      if (batchId && batch._id.toString() !== batchId) return;
      if (!batch.users) return;
      const before = batch.users.length;
      batch.users = batch.users.filter(
        batchUser => !(batchUser.user && batchUser.user.toString() === userId)
      );
      if (batch.users.length !== before) {
        removedFromBatches++;
        batch.updatedAt = new Date();
        if (req.user?.id) batch.updatedBy = req.user.id;
      }
    });

    if (removedFromBatches === 0) {
      return res.status(404).json({
        success: false,
        message: 'Participant not found in this course'
      });
    }

    // Update course
    course.updatedAt = new Date();
    course.updatedBy = req.user?.id || 'system';
    
    await course.save();

    // Send notification to the removed user
    let notificationSent = false;
    let notificationError = null;
    
    try {
      const notification = {
        title: 'Course Enrollment Removed',
        message: `You have been removed from the course "${course.courseName}"`,
        type: 'warning',
        relatedEntity: 'enrollment',
        relatedEntityId: courseId,
        removedBy: req.user?.email,
        metadata: new Map([
          ['Course Name', course.courseName],
          ['Course Code', course.courseCode],
          ['Removal Date', new Date().toISOString()],
          ['Removed By', req.user?.email || 'system'],
        ]),
      };

      // Check if the participant object has the addNotification method
      if (typeof participant.addNotification === 'function') {
        await participant.addNotification(notification);
        notificationSent = true;
      } else {
    
        const updatedUser = await User.findByIdAndUpdate(
          participantId,
          {
            $push: {
              notifications: {
                $each: [{
                  title: notification.title,
                  message: notification.message,
                  type: notification.type,
                  relatedEntity: notification.relatedEntity,
                  relatedEntityId: notification.relatedEntityId,
                  read: false,
                  createdAt: new Date()
                }],
                $position: 0
              }
            },
            $inc: { unreadNotificationCount: 1 }
          },
          { new: true }
        );
        
        if (updatedUser) {
          notificationSent = true;
        }
      }
    } catch (error) {
      notificationError = error.message;
      console.error(`Failed to send notification to user ${participantId}:`, error);
      // Don't fail the whole operation if notification fails
    }

    // Send email to the removed user
    let emailSent = false;
    let emailError = null;
    
    try {
      const emailSubject = `Course Enrollment Removed: ${course.courseName}`;
      const emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #2c3e50;">Course Enrollment Update</h2>
          <p>Dear ${participant.firstName} ${participant.lastName || ''},</p>
          <p>Your enrollment in the following course has been removed:</p>
          <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #e74c3c;">
            <h3 style="margin-top: 0; color: #e74c3c;">${course.courseName}</h3>
            <p><strong>Course Code:</strong> ${course.courseCode}</p>
            <p><strong>Removal Date:</strong> ${new Date().toLocaleDateString()}</p>
            <p><strong>Removed By:</strong> ${req.user?.email ? 'System Administrator' : 'System'}</p>
          </div>
          <p>If you believe this is an error or have any questions, please contact your course instructor or system administrator.</p>
          <p>You will no longer have access to the course material through your LMS account.</p>
          <br>
          <p>Best regards,<br>LMS Team</p>
        </div>
      `;

      // Send the email using your existing function
      const emailResult = await sendEmail(
        [participant.email],  // to
        emailSubject,         // subject
        emailBody,            // body
        []                    // cc (empty array)
      );

      emailSent = emailResult ? true : false;
    } catch (error) {
      emailError = error.message;
      console.error(`Failed to send email to ${participant.email}:`, error);
      // Don't fail the whole operation if email fails
    }

    // Return success response with updated course
    const updatedCourse = await CourseStructure.findById(courseId)
      .populate({
        path: 'batchAndParticipants.users.user',
        select: 'firstName lastName email phone role status'
      });

    res.status(200).json({
      success: true,
      message: 'Participant removed successfully',
      data: {
        course: updatedCourse,
        removedParticipant: {
          id: participant._id,
          name: `${participant.firstName} ${participant.lastName || ''}`.trim(),
          email: participant.email,
          removedAt: new Date(),
          removedBy: req.user?.email || 'system'
        },
        notification: {
          sent: notificationSent,
          error: notificationError
        },
        email: {
          sent: emailSent,
          error: emailError
        }
      }
    });

  } catch (error) {
    console.error('Error removing participant:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove participant',
      error: error.message
    });
  }
};

exports.deleteMultipleParticipants = async (req, res) => {
  try {
    const { courseId } = req.params;
    // batchId is optional — when given, users are removed from that batch only.
    const { participantIds, batchId } = req.body;

    // Validate input
    if (!Array.isArray(participantIds) || participantIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'participantIds must be a non-empty array'
      });
    }

    // Validate ObjectIds
    const validParticipantIds = participantIds.filter(id => 
      mongoose.Types.ObjectId.isValid(id)
    );

    if (validParticipantIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid participant IDs provided'
      });
    }

    // Find course
    const course = await CourseStructure.findById(courseId);

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // Check if course has batches with participants
    if (!course.batchAndParticipants || !Array.isArray(course.batchAndParticipants)) {
      return res.status(404).json({
        success: false,
        message: 'No participants found in this course'
      });
    }

    // Get all participants to be removed
    const participantsToRemove = await User.find({
      _id: { $in: validParticipantIds }
    }).select('_id firstName lastName email');

    if (participantsToRemove.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No valid users found with the provided IDs'
      });
    }

    const participantMap = new Map();
    participantsToRemove.forEach(participant => {
      participantMap.set(participant._id.toString(), participant);
    });

    let removedCount = 0;
    const removedParticipants = [];
    const removedParticipantIds = [];

    // Remove matching users from every matching batch they appear in
    course.batchAndParticipants.forEach(batch => {
      if (batchId && batch._id.toString() !== batchId) return;
      if (!batch.users) return;
      const before = batch.users.length;
      batch.users = batch.users.filter(batchUser => {
        const idStr = batchUser.user ? batchUser.user.toString() : null;
        if (idStr && validParticipantIds.includes(idStr)) {
          const participant = participantMap.get(idStr);
          if (participant && !removedParticipantIds.includes(idStr)) {
            removedParticipants.push(participant);
            removedParticipantIds.push(idStr);
          }
          removedCount++;
          return false; // Remove this user from the batch
        }
        return true; // Keep this user
      });
      if (batch.users.length !== before) {
        batch.updatedAt = new Date();
        if (req.user?.id) batch.updatedBy = req.user.id;
      }
    });

    if (removedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'No matching participants found in this course'
      });
    }

    // Update metadata
    course.updatedAt = new Date();
    course.updatedBy = req.user?.id || 'system';

    await course.save();

    // Send notifications to all removed users
    const notificationResults = [];
    const notificationPromises = removedParticipants.map(async (participant) => {
      try {
        const notification = {
          title: 'Course Enrollment Removed',
          message: `You have been removed from the course "${course.courseName}"`,
          type: 'warning',
          relatedEntity: 'enrollment',
          relatedEntityId: courseId,
          removedBy: req.user?.email,
          metadata: new Map([
            ['Course Name', course.courseName],
            ['Course Code', course.courseCode],
            ['Removal Date', new Date().toISOString()],
            ['Removed By', req.user?.email || 'system'],
          ]),
        };

        // Get full user document to ensure methods are available
        const userDoc = await User.findById(participant._id);
        
        if (userDoc && typeof userDoc.addNotification === 'function') {
          await userDoc.addNotification(notification);
          notificationResults.push({
            userId: participant._id,
            success: true,
            email: participant.email
          });
        } else {
          // Fallback: Update notifications directly
          await User.findByIdAndUpdate(
            participant._id,
            {
              $push: {
                notifications: {
                  $each: [{
                    title: notification.title,
                    message: notification.message,
                    type: notification.type,
                    relatedEntity: notification.relatedEntity,
                    relatedEntityId: notification.relatedEntityId,
                    read: false,
                    createdAt: new Date()
                  }],
                  $position: 0
                }
              },
              $inc: { unreadNotificationCount: 1 }
            }
          );
          notificationResults.push({
            userId: participant._id,
            success: true,
            email: participant.email,
            method: 'fallback'
          });
        }
      } catch (error) {
        console.error(`Failed to send notification to user ${participant._id}:`, error);
        notificationResults.push({
          userId: participant._id,
          success: false,
          email: participant.email,
          error: error.message
        });
      }
    });

    await Promise.all(notificationPromises);

    // Send emails to all removed users
    const emailResults = [];
    const emailPromises = removedParticipants.map(async (participant) => {
      try {
        const emailSubject = `Course Enrollment Removed: ${course.courseName}`;
        const emailBody = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #2c3e50;">Course Enrollment Update</h2>
            <p>Dear ${participant.firstName} ${participant.lastName || ''},</p>
            <p>Your enrollment in the following course has been removed:</p>
            <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #e74c3c;">
              <h3 style="margin-top: 0; color: #e74c3c;">${course.courseName}</h3>
              <p><strong>Course Code:</strong> ${course.courseCode}</p>
              <p><strong>Removal Date:</strong> ${new Date().toLocaleDateString()}</p>
              <p><strong>Removed By:</strong> ${req.user?.email ? 'System Administrator' : 'System'}</p>
            </div>
            <p>If you believe this is an error or have any questions, please contact your course instructor or system administrator.</p>
            <p>You will no longer have access to the course material through your LMS account.</p>
            <br>
            <p>Best regards,<br>LMS Team</p>
          </div>
        `;

        const emailSent = await sendEmail(
          [participant.email],
          emailSubject,
          emailBody,
          []
        );

        emailResults.push({
          userId: participant._id,
          email: participant.email,
          success: emailSent ? true : false
        });

      } catch (error) {
        console.error(`Failed to send email to ${participant.email}:`, error);
        emailResults.push({
          userId: participant._id,
          email: participant.email,
          success: false,
          error: error.message
        });
      }
    });

    // Send emails in background (don't wait for completion)
    Promise.all(emailPromises)
      .then(results => {
        const successfulEmails = results.filter(r => r && r.success).length;
        const failedEmails = results.filter(r => !r || !r.success).length;
      })
      .catch(error => {
        console.error('Error in email sending process:', error);
      });

    // Populate the response with user data
    const updatedCourse = await CourseStructure.findById(courseId)
      .populate({
        path: 'batchAndParticipants.users.user',
        select: 'firstName lastName email'
      });

    // Calculate statistics
    const successfulNotifications = notificationResults.filter(r => r.success).length;
    const failedNotifications = notificationResults.filter(r => !r.success).length;
    
    const successfulEmails = emailResults.filter(r => r.success).length;
    const failedEmails = emailResults.filter(r => !r.success).length;

    res.status(200).json({
      success: true,
      message: `${removedCount} participant(s) removed successfully`,
      data: {
        course: updatedCourse,
        removalSummary: {
          totalRemoved: removedCount,
          removedParticipants: removedParticipants.map(p => ({
            id: p._id,
            name: `${p.firstName} ${p.lastName || ''}`.trim(),
            email: p.email
          })),
          removedAt: new Date(),
          removedBy: req.user?.id || 'system'
        },
        notifications: {
          total: notificationResults.length,
          successful: successfulNotifications,
          failed: failedNotifications,
          details: notificationResults
        },
        emails: {
          total: emailResults.length,
          successful: successfulEmails,
          failed: failedEmails,
          details: emailResults
        }
      }
    });

  } catch (error) {
    console.error('Error removing participants:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove participants',
      error: error.message
    });
  }
};

// ============================================================================
// Approval Hierarchy (course-level template for sequential approvals)
// ============================================================================

const Role = require("../../models/RoleModel");
// User is already required at the top of this file (const User = ...) — do
// not re-declare here.

// GET /courses/:courseId/approval-hierarchy
// Returns the effective chain PLUS the two dropdowns the person-specific
// hierarchy UI needs: institution roles (excluding Student) and, for each
// role, the users of the institution holding it. Front-end filters the
// people list by the picked roleId — no per-role network round trip.
exports.getApprovalHierarchy = async (req, res) => {
  try {
    const { courseId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(courseId)) {
      return res.status(400).json({ success: false, message: "Invalid courseId" });
    }

    // No roster populate here: the hydrated participant list (potentially
    // hundreds of users + nested roles) was only ever consumed by the legacy
    // no-institution fallback below, which now runs its own targeted query.
    const course = await CourseStructure.findById(courseId)
      .select("approvalHierarchy institution")
      .lean();

    if (!course) {
      return res.status(404).json({ success: false, message: "Course not found" });
    }

    // Selectable approver roles: every role of this course's institution.
    // Approver roles like L&D usually aren't on the course roster, so an
    // enrolled-only list would make them unpickable — and enrolled roles from
    // OTHER institutions must not be offered because the PUT below rejects
    // them. Students are excluded — the audience, not approvers — matched by
    // roleValue (the stable identifier; display names are freely renameable),
    // with the exact display name as fallback.
    const seen = new Map();
    const addRole = (r) => {
      if (!r || !r._id) return;
      const roleName = r.renameRole || r.originalRole || r.roleValue || "";
      const roleValue = (r.roleValue || "").toLowerCase();
      if (roleValue === "student" || roleName.trim().toLowerCase() === "student") return;
      if (!roleName) return; // nameless role — unselectable, PUT would 400 anyway
      seen.set(r._id.toString(), { roleId: r._id, roleName });
    };

    // The three lookups below depend only on course.institution /
    // approvalHierarchy — run them concurrently (they were serialized).
    const { getEffectiveHierarchySteps } = require("../../utils/approvalWorkflow");
    const [institutionRoles, activeUsers, effective] = await Promise.all([
      course.institution
        ? Role.find({ institution: course.institution })
            .select("_id renameRole originalRole roleValue")
            .lean()
        : Promise.resolve(null),
      course.institution
        ? User.find({ institution: course.institution, status: "active" })
            .select("_id firstName lastName email role")
            .lean()
        : Promise.resolve(null),
      // When the course has no chain of its own, expose the L&D default so
      // the client can show the effective chain ("L&D — default").
      getEffectiveHierarchySteps(course),
    ]);

    if (institutionRoles) {
      institutionRoles.forEach(addRole);
    } else {
      // Legacy course without an institution ref — fall back to the roles of
      // enrolled participants so the modal isn't empty. Rare path; only here
      // do we pay for roster hydration.
      const legacyCourse = await CourseStructure.findById(courseId)
        .select("batchAndParticipants")
        .populate({
          path: "batchAndParticipants.users.user",
          select: "_id firstName lastName role",
          populate: { path: "role", select: "_id renameRole originalRole" },
        })
        .lean();
      (legacyCourse?.batchAndParticipants || []).forEach((batch) => {
        (batch.users || []).forEach((e) => addRole(e?.user?.role));
      });
    }

    // People pickable per role. Institution-scoped for the same reason as
    // roles — PUT rejects a userId from another institution. Only ACTIVE users
    // so the manager doesn't wire the chain to a deactivated account. Users
    // whose role isn't in `seen` (student, or a role not in the institution)
    // are dropped — they'd be un-pickable anyway. `availableUsersByRole` is a
    // { roleId: User[] } dictionary so the front-end filters instantly.
    const availableUsersByRole = {};
    if (activeUsers) {
      activeUsers.forEach((u) => {
        if (!u.role) return;
        const rid = u.role.toString();
        if (!seen.has(rid)) return;
        (availableUsersByRole[rid] = availableUsersByRole[rid] || []).push({
          userId: u._id,
          name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || "Unnamed user",
          email: u.email || "",
        });
      });
      // Sort each role's people alphabetically for a stable dropdown order.
      Object.keys(availableUsersByRole).forEach((rid) => {
        availableUsersByRole[rid].sort((a, b) => a.name.localeCompare(b.name));
      });
    }

    res.status(200).json({
      success: true,
      data: {
        steps: effective.steps,
        source: effective.source,
        updatedAt: course.approvalHierarchy?.updatedAt || null,
        updatedBy: course.approvalHierarchy?.updatedBy || null,
        availableRoles: Array.from(seen.values()),
        availableUsersByRole,
      },
    });
  } catch (error) {
    console.error("Error fetching approval hierarchy:", error);
    res.status(500).json({ success: false, message: "Failed to fetch approval hierarchy", error: error.message });
  }
};

// PUT /courses/:courseId/approval-hierarchy
// Body: { steps: [{ order, roleId, userId }] }  — roleName + userName are
// re-derived server-side (never trust the client). userId is REQUIRED under
// the person-specific rework: the picked user is the actual approver; the
// role is only there to filter the picker. The old "one role per chain"
// rule is intentionally dropped — the manager may legitimately want two
// different Managers to approve at two different levels.
exports.updateApprovalHierarchy = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { steps } = req.body;

    if (!mongoose.Types.ObjectId.isValid(courseId)) {
      return res.status(400).json({ success: false, message: "Invalid courseId" });
    }
    if (!Array.isArray(steps)) {
      return res.status(400).json({ success: false, message: "steps must be an array" });
    }

    const course = await CourseStructure.findById(courseId);
    if (!course) {
      return res.status(404).json({ success: false, message: "Course not found" });
    }

    // Validate ids first, then the (role, user) pair per step in one pass.
    const submittedRoleIds = [];
    const submittedUserIds = [];
    const pairSeen = new Set();
    for (const s of steps) {
      if (!s || !mongoose.Types.ObjectId.isValid(s.roleId)) {
        return res.status(400).json({ success: false, message: "Each step needs a valid roleId" });
      }
      if (!s.userId || !mongoose.Types.ObjectId.isValid(s.userId)) {
        return res.status(400).json({
          success: false,
          message: "Each step needs a specific person selected (userId is required)",
        });
      }
      const rid = s.roleId.toString();
      const uid = s.userId.toString();
      const pair = `${rid}:${uid}`;
      if (pairSeen.has(pair)) {
        return res.status(400).json({
          success: false,
          message: "The same person cannot appear twice under the same role",
        });
      }
      pairSeen.add(pair);
      submittedRoleIds.push(rid);
      submittedUserIds.push(uid);
    }

    // Resolve role docs — server-side name derivation, institution check,
    // reject Student by roleValue (stable identifier; display names are
    // freely renameable so a "Learners" role with roleValue 'student' must
    // still be rejected).
    const roleDocs = await Role.find({ _id: { $in: submittedRoleIds } })
      .select("_id renameRole originalRole roleValue institution");
    const courseInstitution = course.institution ? course.institution.toString() : null;
    const roleMap = new Map();
    for (const rid of submittedRoleIds) {
      if (roleMap.has(rid)) continue; // already validated
      const doc = roleDocs.find((r) => r._id.toString() === rid);
      if (!doc) {
        return res.status(400).json({ success: false, message: "Unknown role in steps" });
      }
      if (courseInstitution && doc.institution && doc.institution.toString() !== courseInstitution) {
        return res.status(400).json({ success: false, message: "All steps must use roles from this course's institution" });
      }
      const roleName = doc.renameRole || doc.originalRole || doc.roleValue || "";
      const roleValue = (doc.roleValue || "").toLowerCase();
      if (roleValue === "student" || roleName.trim().toLowerCase() === "student") {
        return res.status(400).json({ success: false, message: "Student role cannot be an approver" });
      }
      if (!roleName) {
        // roleName is required on the step schema — an empty string would
        // fail validation at save() and surface as an opaque 500.
        return res.status(400).json({ success: false, message: "A selected role has no name — set its name first" });
      }
      roleMap.set(rid, roleName);
    }

    // Resolve user docs. Each user must belong to this course's institution
    // AND their current role must equal the roleId the manager picked for
    // this step. This is the same rule the front-end enforces by filtering
    // the People dropdown by the picked role — the server refuses to be
    // tricked into wiring a Manager slot to an HR user.
    const userDocs = await User.find({ _id: { $in: submittedUserIds } })
      .select("_id firstName lastName email role institution status");
    const userMap = new Map();
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const uid = s.userId.toString();
      const rid = s.roleId.toString();
      const doc = userDocs.find((u) => u._id.toString() === uid);
      if (!doc) {
        return res.status(400).json({
          success: false,
          message: `Step ${i + 1}: selected person no longer exists`,
        });
      }
      if (courseInstitution && doc.institution && doc.institution.toString() !== courseInstitution) {
        return res.status(400).json({
          success: false,
          message: `Step ${i + 1}: selected person is not part of this institution`,
        });
      }
      if (!doc.role || doc.role.toString() !== rid) {
        return res.status(400).json({
          success: false,
          message: `Step ${i + 1}: selected person does not hold the "${roleMap.get(rid)}" role anymore`,
        });
      }
      // Legacy user docs may have `status` unset (the field has no default in
      // UserModel); treat "not explicitly active" as inactive, matching the
      // picker's own `status: "active"` filter — otherwise a hand-crafted
      // PUT could wire someone the modal would never surface.
      if (doc.status !== "active") {
        return res.status(400).json({
          success: false,
          message: `Step ${i + 1}: selected person is inactive — pick someone else`,
        });
      }
      const userName = [doc.firstName, doc.lastName].filter(Boolean).join(" ")
        || doc.email
        || "Approver";
      userMap.set(uid, { name: userName });
    }

    const normalisedSteps = steps.map((s, idx) => ({
      order: idx + 1,
      roleId: s.roleId,
      roleName: roleMap.get(s.roleId.toString()),
      userId: s.userId,
      userName: userMap.get(s.userId.toString()).name,
    }));

    course.approvalHierarchy = {
      steps: normalisedSteps,
      updatedBy: req.user?._id || req.user?.id || null,
      updatedAt: new Date(),
    };
    course.updatedAt = new Date();
    course.updatedBy = req.user?.email || "system";
    await course.save();

    res.status(200).json({
      success: true,
      message: normalisedSteps.length
        ? "Approval hierarchy saved"
        : "Approval hierarchy cleared",
      data: {
        steps: normalisedSteps,
        updatedAt: course.approvalHierarchy.updatedAt,
        updatedBy: course.approvalHierarchy.updatedBy,
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    console.error("Error updating approval hierarchy:", error);
    res.status(status).json({ success: false, message: error.message || "Failed to update approval hierarchy" });
  }
};