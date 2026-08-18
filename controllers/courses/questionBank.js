const Question = require('../../models/Courses/QuestionbankModal');
const { createClient } = require("@supabase/supabase-js");
const mongoose = require('mongoose');

const supabaseKey = process.env.SUPABASE_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabase = createClient(supabaseUrl, supabaseKey);

// DO NOT add `.lean()` to the question-bank reads. Measured against live data:
// hydration materialises 11 schema-defaulted fields that are absent from the
// stored BSON — hasOtherOption, essayAnswer, problemType, topics, tags,
// timeComplexity, spaceComplexity, source, outputCode and the two
// _clonedFromExercise markers — on 31 of this institution's 81 questions.
// `.lean()` returns raw BSON, so all of them would silently disappear from the
// response (104,458 -> 97,762 bytes), breaking any consumer that reads
// `q.topics` / `q.tags` as arrays or branches on `q.source`. The sub-schema's
// toJSON transform (QuestionbankModal.js) is a second, independent reason the
// two paths do not serialise identically.

// Helper function to clean empty fields
const cleanEmptyFields = (obj) => {
  Object.keys(obj).forEach(key => {
    if (obj[key] && typeof obj[key] === 'object') {
      cleanEmptyFields(obj[key]);
    }
    
    if (Array.isArray(obj[key]) && obj[key].length === 0) {
      delete obj[key];
    }
    else if (obj[key] && typeof obj[key] === 'object' && 
             Object.keys(obj[key]).length === 0) {
      delete obj[key];
    }
    else if (obj[key] === undefined || obj[key] === null) {
      delete obj[key];
    }
  });
  return obj;
};

// Image upload helper
async function uploadImageToSupabase(file, folderPath) {
  try {
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 8);
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9.]/g, '_');
    const fileName = `${timestamp}_${randomString}_${sanitizedName}`;
    const filePath = `question-bank/${folderPath}/${fileName}`;

    const { data, error } = await supabase.storage
      .from("smartlms")
      .upload(filePath, file.data || file.buffer, {
        contentType: file.mimetype || 'image/jpeg',
        cacheControl: '3600',
        upsert: false
      });

    if (error) {
      throw new Error(`Supabase upload failed: ${error.message}`);
    }

    const imageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/smartlms/${filePath}`;
    return imageUrl;
  } catch (error) {
    console.error("❌ Image upload failed:", error);
    throw error;
  }
}

// Update the normalizeMCQQuestion function
const normalizeMCQQuestion = (question) => {
  // Normalize mcqQuestionTitle
  if (question.mcqQuestionTitle) {
    if (typeof question.mcqQuestionTitle === 'string') {
      question.mcqQuestionTitle = {
        text: question.mcqQuestionTitle,
        imageUrl: null,
        imageAlignment: 'center',
        imageSizePercent: 60
      };
    } else if (typeof question.mcqQuestionTitle === 'object') {
      // Ensure all required fields exist
      if (!question.mcqQuestionTitle.imageUrl) {
        question.mcqQuestionTitle.imageUrl = null;
      }
      if (!question.mcqQuestionTitle.imageAlignment) {
        question.mcqQuestionTitle.imageAlignment = 'center';
      }
      if (!question.mcqQuestionTitle.imageSizePercent) {
        question.mcqQuestionTitle.imageSizePercent = 60;
      }
    }
  } else if (question.questionTitle && typeof question.questionTitle === 'string') {
    question.mcqQuestionTitle = {
      text: question.questionTitle,
      imageUrl: null,
      imageAlignment: 'center',
      imageSizePercent: 60
    };
  }

  // Normalize mcqQuestionDescription
  if (question.mcqQuestionDescription) {
    if (typeof question.mcqQuestionDescription === 'string') {
      question.mcqQuestionDescription = {
        text: question.mcqQuestionDescription,
        imageUrl: null,
        imageAlignment: 'center',
        imageSizePercent: 60
      };
    } else if (typeof question.mcqQuestionDescription === 'object') {
      // Ensure all required fields exist
      if (!question.mcqQuestionDescription.imageUrl) {
        question.mcqQuestionDescription.imageUrl = null;
      }
      if (!question.mcqQuestionDescription.imageAlignment) {
        question.mcqQuestionDescription.imageAlignment = 'center';
      }
      if (!question.mcqQuestionDescription.imageSizePercent) {
        question.mcqQuestionDescription.imageSizePercent = 60;
      }
    }
  }

  return question;
};

// Update your createQuestionBank function - FIXED VERSION
exports.createQuestionBank = async (req, res) => {
  try {
    const institutionId = req.user?.institution?._id || req.user?.institution;
    
    if (!institutionId) {
      return res.status(400).json({
        success: false,
        message: 'User institution not found'
      });
    }

    // Parse questionsData from FormData
    let questionsData = [];
    
    if (req.body.questionsData) {
      if (typeof req.body.questionsData === 'string') {
        try {
          questionsData = JSON.parse(req.body.questionsData);
          console.log('✅ Parsed questionsData:', questionsData.length, 'questions');
        } catch (e) {
          return res.status(400).json({
            success: false,
            message: 'Invalid questionsData format - must be valid JSON array'
          });
        }
      } else if (Array.isArray(req.body.questionsData)) {
        questionsData = req.body.questionsData;
      }
    } else if (Array.isArray(req.body)) {
      questionsData = req.body;
    } else if (req.body.questionType) {
      questionsData = [req.body];
    }

    questionsData = questionsData.filter(q => q != null);

    if (!Array.isArray(questionsData) || questionsData.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'questionsData must be a non-empty array'
      });
    }

    const processedQuestions = [];

    for (let i = 0; i < questionsData.length; i++) {
      let question = questionsData[i];
      
      // Normalize the question data first
      question = normalizeMCQQuestion(question);
      
      const isMCQ = question.questionType === 'MCQ' || 
                    question.questionType === 'mcq' ||
                    question.mcqQuestionTitle || 
                    question.mcqQuestionType;

      let processedQuestion;

      if (isMCQ) {
        console.log(`📝 Question ${i + 1}: Processing as MCQ`);
        
        // Handle mcqQuestionTitle as object (already normalized)
        let mcqTitleObj = question.mcqQuestionTitle || { text: '' };
        
        if (typeof mcqTitleObj === 'string') {
          mcqTitleObj = { text: mcqTitleObj };
        }

        // Handle mcqQuestionDescription as object (already normalized)
        let mcqDescriptionObj = question.mcqQuestionDescription || null;
        
        if (mcqDescriptionObj && typeof mcqDescriptionObj === 'string') {
          mcqDescriptionObj = { text: mcqDescriptionObj };
        }

        const mcqType = question.mcqQuestionType || 'multiple_choice';
        const mcqOptions = question.mcqQuestionOptions || question.options || [];
        const mcqCorrectAnswers = question.mcqQuestionCorrectAnswers || 
                                 question.correctAnswers || 
                                 (question.correctAnswer ? [question.correctAnswer] : []);
        
        // Validate MCQ required fields
        if (!mcqTitleObj.text || !mcqTitleObj.text.trim()) {
          return res.status(400).json({
            success: false,
            message: `Question ${i + 1}: MCQ question title text is required`
          });
        }

        const choiceBasedTypes = ['multiple_choice', 'multiple_select', 'dropdown'];
        
        if (choiceBasedTypes.includes(mcqType)) {
          if (!Array.isArray(mcqOptions) || mcqOptions.length < 2) {
            return res.status(400).json({
              success: false,
              message: `Question ${i + 1}: At least 2 options are required for ${mcqType}`
            });
          }

          if (!Array.isArray(mcqCorrectAnswers) || mcqCorrectAnswers.length === 0) {
            return res.status(400).json({
              success: false,
              message: `Question ${i + 1}: At least one correct answer is required`
            });
          }
        }

        if (mcqType === 'true_false') {
          if (question.trueFalseAnswer === undefined || question.trueFalseAnswer === null) {
            return res.status(400).json({
              success: false,
              message: `Question ${i + 1}: True/False answer is required`
            });
          }
        }

        if (mcqType === 'matching') {
          const matchingPairs = question.matchingPairs || [];
          if (matchingPairs.length < 2) {
            return res.status(400).json({
              success: false,
              message: `Question ${i + 1}: At least 2 matching pairs are required`
            });
          }
          const hasEmptyPairs = matchingPairs.some(p => !p.left?.trim() || !p.right?.trim());
          if (hasEmptyPairs) {
            return res.status(400).json({
              success: false,
              message: `Question ${i + 1}: All matching pairs must be filled`
            });
          }
        }

        if (mcqType === 'ordering') {
          const orderingItems = question.orderingItems || [];
          if (orderingItems.length < 2) {
            return res.status(400).json({
              success: false,
              message: `Question ${i + 1}: At least 2 ordering items are required`
            });
          }
          const hasEmptyItems = orderingItems.some(item => !item.text?.trim());
          if (hasEmptyItems) {
            return res.status(400).json({
              success: false,
              message: `Question ${i + 1}: All ordering items must be filled`
            });
          }
        }

        if (mcqType === 'numeric') {
          if (question.numericAnswer === undefined || question.numericAnswer === null) {
            return res.status(400).json({
              success: false,
              message: `Question ${i + 1}: Numeric answer is required`
            });
          }
        }

        // ========== FIX: Process mcqQuestionTitle image upload ==========
        let titleImageUrl = mcqTitleObj.imageUrl || null;
        const titleImageField = `question_${i}_image`; // Changed to match frontend
        const titleImageFile = req.files?.[titleImageField];

        if (titleImageFile) {
          try {
            titleImageUrl = await uploadImageToSupabase(
              titleImageFile,
              `mcq/title/${Date.now()}_${i}`
            );
            console.log(`✅ Uploaded title image for question ${i + 1}:`, titleImageUrl);
          } catch (uploadError) {
            console.error(`Error uploading title image for question ${i + 1}:`, uploadError);
          }
        }

        // Process mcqQuestionDescription image upload
        let descriptionImageUrl = mcqDescriptionObj?.imageUrl || null;
        const descriptionImageField = `question_${i}_explanation_image`;
        const descriptionImageFile = req.files?.[descriptionImageField];

        if (descriptionImageFile) {
          try {
            descriptionImageUrl = await uploadImageToSupabase(
              descriptionImageFile,
              `mcq/description/${Date.now()}_${i}`
            );
            console.log(`✅ Uploaded description image for question ${i + 1}:`, descriptionImageUrl);
          } catch (uploadError) {
            console.error(`Error uploading description image for question ${i + 1}:`, uploadError);
          }
        }

        let explanationImageUrl = null;
        const explanationImageField = `question_${i}_explanation_image`;
        const explanationImageFile = req.files?.[explanationImageField];

        if (explanationImageFile) {
          try {
            explanationImageUrl = await uploadImageToSupabase(
              explanationImageFile,
              `mcq/explanation/${Date.now()}_${i}`
            );
            console.log(`✅ Uploaded explanation image for question ${i + 1}:`, explanationImageUrl);
          } catch (uploadError) {
            console.error(`Error uploading explanation image for question ${i + 1}:`, uploadError);
          }
        }

        // Build mcqQuestionDescription object (explanation) with image
        let finalMcqDescriptionObj = mcqDescriptionObj ? { ...mcqDescriptionObj } : null;
        
        if (explanationImageUrl) {
          if (!finalMcqDescriptionObj) {
            finalMcqDescriptionObj = {};
          }
          finalMcqDescriptionObj.imageUrl = explanationImageUrl;
          if (!finalMcqDescriptionObj.imageAlignment) finalMcqDescriptionObj.imageAlignment = 'center';
          if (!finalMcqDescriptionObj.imageSizePercent) finalMcqDescriptionObj.imageSizePercent = 60;
        }

        // Process options with images
        let processedOptions = [];
        if (choiceBasedTypes.includes(mcqType)) {
          processedOptions = await Promise.all(
            mcqOptions.map(async (option, optIndex) => {
              let imageUrl = option.imageUrl || null;
              
              const imageField = `question_${i}_option_${optIndex}_image`;
              const imageFile = req.files?.[imageField];

              if (imageFile) {
                try {
                  imageUrl = await uploadImageToSupabase(
                    imageFile,
                    `mcq/option/${Date.now()}_${i}_${optIndex}`
                  );
                  console.log(`✅ Uploaded option ${optIndex} image for question ${i + 1}:`, imageUrl);
                } catch (uploadError) {
                  console.error(`Error uploading image for option ${optIndex}:`, uploadError);
                }
              }

              return {
                _id: new mongoose.Types.ObjectId(),
                text: option.text || '',
                isCorrect: option.isCorrect || false,
                imageUrl: imageUrl,
                imageAlignment: option.imageAlignment || 'left',
                imageSizePercent: option.imageSizePercent || 100
              };
            })
          );
        }

        // ========== FIX: Build mcqQuestionTitle object with uploaded image URL ==========
        const finalMcqTitleObj = {
          text: mcqTitleObj.text,
          ...(titleImageUrl && { imageUrl: titleImageUrl }),
          ...(mcqTitleObj.imageAlignment && { imageAlignment: mcqTitleObj.imageAlignment }),
          ...(mcqTitleObj.imageSizePercent && { imageSizePercent: mcqTitleObj.imageSizePercent })
        };

        // Build base MCQ question object
        processedQuestion = {
          _id: new mongoose.Types.ObjectId(),
          questionCategory: question.questionCategory || 'General',
          questionType: 'mcq',
          isActive: question.isActive !== undefined ? question.isActive : true,
          mcqQuestionTitle: finalMcqTitleObj, // Now includes the uploaded image URL
          ...(finalMcqDescriptionObj && finalMcqDescriptionObj.text && { mcqQuestionDescription: finalMcqDescriptionObj }),
          mcqQuestionType: mcqType,
          mcqQuestionDifficulty: question.mcqQuestionDifficulty || question.difficulty || 'medium',
          mcqQuestionScore: question.mcqQuestionScore || question.score || 10,
          mcqQuestionTimeLimit: question.mcqQuestionTimeLimit || question.timeLimit || 0,
          mcqQuestionOptionsPerRow: question.mcqQuestionOptionsPerRow || question.optionsPerRow || 1,
          mcqQuestionRequired: question.mcqQuestionRequired === true,
          createdBy: req.user?.email || 'system',
          updatedBy: req.user?.email || 'system',
          createdAt: new Date(),
          updatedAt: new Date()
        };

        // Add type-specific fields
        if (choiceBasedTypes.includes(mcqType)) {
          processedQuestion.mcqQuestionOptions = processedOptions;
          processedQuestion.mcqQuestionCorrectAnswers = mcqCorrectAnswers;
        }

        if (mcqType === 'true_false') {
          processedQuestion.trueFalseAnswer = question.trueFalseAnswer;
        }

        if (mcqType === 'short_answer') {
          processedQuestion.shortAnswer = question.shortAnswer || '';
        }

        if (mcqType === 'essay') {
          processedQuestion.essayAnswer = question.essayAnswer || '';
        }

        if (mcqType === 'matching') {
          processedQuestion.matchingPairs = (question.matchingPairs || []).map(p => ({
            _id: new mongoose.Types.ObjectId(),
            left: p.left || '',
            right: p.right || ''
          }));
        }

        if (mcqType === 'ordering') {
          processedQuestion.orderingItems = (question.orderingItems || []).map(item => ({
            _id: new mongoose.Types.ObjectId(),
            text: item.text || '',
            order: item.order || 0
          }));
        }

        if (mcqType === 'numeric') {
          processedQuestion.numericAnswer = question.numericAnswer;
          processedQuestion.numericTolerance = question.numericTolerance || null;
        }

        if (question.hasExplanation || (finalMcqDescriptionObj && finalMcqDescriptionObj.text)) {
          processedQuestion.hasExplanation = true;
          processedQuestion.explanation = finalMcqDescriptionObj?.text || question.explanation || '';
        }

      } else {
        // Programming question processing (unchanged)
        console.log(`📝 Question ${i + 1}: Processing as Programming`);
        
        if (!question.title) {
          return res.status(400).json({
            success: false,
            message: `Question ${i + 1}: Programming question title is required`
          });
        }

        if (!question.description) {
          return res.status(400).json({
            success: false,
            message: `Question ${i + 1}: Programming question description is required`
          });
        }

        const testCases = (question.testCases || []).map(tc => ({
          _id: new mongoose.Types.ObjectId(),
          input: tc.input || '',
          expectedOutput: tc.expectedOutput || '',
          isSample: tc.isSample || false,
          isHidden: tc.isHidden || false,
          points: tc.points || 0,
          explanation: tc.explanation || ''
        }));

        const hints = (question.hints || []).map((h, idx) => ({
          _id: new mongoose.Types.ObjectId(),
          hintText: h.hintText || '',
          pointsDeduction: h.pointsDeduction || 0,
          isPublic: h.isPublic || false,
          sequence: h.sequence || idx
        }));

        let solutions = null;
        if (question.solutions) {
          solutions = {
            _id: new mongoose.Types.ObjectId(),
            startedCode: question.solutions.startedCode || '',
            functionName: question.solutions.functionName || '',
            language: question.solutions.language || 'javascript'
          };
        }

        processedQuestion = {
          _id: new mongoose.Types.ObjectId(),
          questionCategory: question.questionCategory || 'Programming',
          // Specific sub-type: programming (core) / frontend / database.
          questionType: (question.questionType || 'programming').toLowerCase(),
          title: question.title,
          description: question.description,
          difficulty: question.difficulty ? question.difficulty.charAt(0).toUpperCase() + question.difficulty.slice(1).toLowerCase() : 'medium',
          sampleInput: question.sampleInput || '',
          sampleOutput: question.sampleOutput || '',
          // Database sub-type fields (were previously dropped).
          sampleQuery: question.sampleQuery || '',
          expectedResult: question.expectedResult || '',
          score: question.score,
          constraints: question.constraints || [],
          hints: hints,
          testCases: testCases,
          solutions: solutions,
          timeLimit: question.timeLimit || 2000,
          memoryLimit: question.memoryLimit || 256,
          isActive: question.isActive !== undefined ? question.isActive : true,
          createdBy: req.user?.email || 'system',
          updatedBy: req.user?.email || 'system',
          createdAt: new Date(),
          updatedAt: new Date()
        };
      }

      // ── Classification metadata (shared by MCQ + programming) ────────────
      // problemType / topics / tags / complexity / source from the Create
      // Question modal. Optional on every path — absent keys stay unset.
      {
        const cleanList = (v) => Array.isArray(v)
          ? v.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim())
          : [];
        const metaTopics = cleanList(question.topics);
        const metaTags = cleanList(question.tags);
        if (question.problemType) processedQuestion.problemType = String(question.problemType);
        if (metaTopics.length) processedQuestion.topics = metaTopics;
        if (metaTags.length) processedQuestion.tags = metaTags;
        if (question.timeComplexity) processedQuestion.timeComplexity = String(question.timeComplexity);
        if (question.spaceComplexity) processedQuestion.spaceComplexity = String(question.spaceComplexity);
        if (question.outputCode) processedQuestion.outputCode = String(question.outputCode);
        if (question.source) processedQuestion.source = String(question.source);
        if (question.hasOtherOption !== undefined) processedQuestion.hasOtherOption = question.hasOtherOption === true;
      }

      // Remove undefined fields
      Object.keys(processedQuestion).forEach(key => {
        if (processedQuestion[key] === undefined || processedQuestion[key] === null) {
          delete processedQuestion[key];
        }
      });

      processedQuestions.push(processedQuestion);
    }

    console.log(`✅ Processed ${processedQuestions.length} questions successfully`);

    let questionBank = await Question.findOne({ institution: institutionId });

    if (questionBank) {
      questionBank.questions.push(...processedQuestions);
      await questionBank.save();
      console.log(`✅ Added ${processedQuestions.length} question(s) to existing question bank`);
    } else {
      questionBank = await Question.create({
        institution: institutionId,
        questions: processedQuestions
      });
      console.log(`✅ Created new question bank with ${processedQuestions.length} question(s)`);
    }

    const isMcq = (q) => (q.questionType || '').toLowerCase() === 'mcq';
    const mcqQuestions = processedQuestions.filter(isMcq);
    const programmingQuestions = processedQuestions.filter(q => !isMcq(q));

    const addedQuestions = processedQuestions.map(q => ({
      questionId: q._id.toString(),
      questionType: q.questionType,
      title: isMcq(q) ? q.mcqQuestionTitle?.text : q.title,
      mcqQuestionType: q.mcqQuestionType,
      difficulty: isMcq(q) ? q.mcqQuestionDifficulty : q.difficulty,
      score: isMcq(q) ? q.mcqQuestionScore : q.score
    }));

    const totalMCQMarks = mcqQuestions.reduce((sum, q) => sum + (q.mcqQuestionScore || 0), 0);
    const totalProgrammingMarks = programmingQuestions.reduce((sum, q) => sum + (q.score || 0), 0);

    return res.status(201).json({
      success: true,
      message: `Successfully added ${addedQuestions.length} question(s) to question bank`,
      data: {
        questionBankId: questionBank._id.toString(),
        totalQuestionsInBank: questionBank.questions.length,
        summary: {
          totalQuestions: addedQuestions.length,
          totalMarks: totalMCQMarks + totalProgrammingMarks,
          byType: {
            MCQ: {
              count: mcqQuestions.length,
              totalMarks: totalMCQMarks
            },
            Programming: {
              count: programmingQuestions.length,
              totalMarks: totalProgrammingMarks
            }
          }
        },
        addedQuestions
      }
    });

  } catch (error) {
    console.error("❌ Error adding questions:", error);
    return res.status(500).json({
      success: false,
      message: 'Error creating questions in question bank',
      error: error.message
    });
  }
};

// ── Question Bank list helpers ───────────────────────────────────────────────
// Verbatim ports of QuestionBanksPage's own derivations — isMcqType, scoreOf,
// inMarksRange and the three-field search — so a server-paginated page holds
// exactly the rows that page's `filteredQuestions` useMemo would have kept.
// Any drift here shows up as questions silently missing from the table.
const isMcqType = (questionType) => String(questionType || '').toLowerCase() === 'mcq';

// MCQ score defaults to 10, programming to its own score (the page's `scoreOf`).
// The MCQ default is load-bearing: drop it and every MCQ falls into the 1-5
// bucket instead of 6-10.
const bankScoreOf = (q) => (isMcqType(q.questionType) ? (q.mcqQuestionScore || 10) : (q.score || 0));

const inMarksRange = (score, range) => {
  if (range === '1-5') return score >= 1 && score <= 5;
  if (range === '6-10') return score >= 6 && score <= 10;
  if (range === '11-20') return score >= 11 && score <= 20;
  if (range === '20+') return score > 20;
  return true;
};

// The page reads `q.questionTitle` for MCQ rows and `q.title` otherwise.
// NOTHING in this collection has a `questionTitle` — the schema calls it
// `mcqQuestionTitle` — so that branch is dead and an MCQ matches a search only
// through its description or category. Ported as-is: this change moves the
// filter to the server, it does not get to change which rows a search returns.
const bankSearchTitle = (q) => (isMcqType(q.questionType) ? q.questionTitle : q.title);

// In the browser `q.description?.toLowerCase()` yields undefined for a missing
// or non-string field; here the same expression would throw, so coerce.
const lcOf = (v) => (typeof v === 'string' ? v.toLowerCase() : '');

// Matches the page's own date comparison. The legacy sort subtracts the Date
// objects directly, which is the same number; an unparseable date sorts as 0
// and is excluded by a date filter, exactly as `Boolean(c)` did client-side.
const bankCreatedMs = (q) => {
  const t = q.createdAt ? new Date(q.createdAt).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
};

// Get all questions with institution filtering
//
// PAGINATION (opt-in via `page`): this response carried the institution's
// entire embedded questions[] array — 114,576 bytes for 89 questions, ~1,290
// B/row and growing with the bank — and QuestionBanksPage rendered every row.
// Passing `page` makes the server run that page's own filter predicate and
// sort, then return one slice plus the facets the page derives from the full
// list (its Category and Created By dropdowns, and the four header stat
// chips). Those are counted over the WHOLE bank, never the visible page, or
// the filter options would disappear as you filter.
//
// Callers that DON'T pass `page` get the original untouched response, so the
// authoring picker (QuestionBankSelector, which shares this cache entry) keeps
// working unchanged.
//
// Deliberately NOT an aggregation: `$unwind`/`$facet` returns raw BSON, which
// is precisely what `.lean()` does and carries the defect the note at the top
// of this file describes — the 11 schema-defaulted fields absent from stored
// BSON would vanish, and the sub-schema's toJSON transform would stop firing.
// The bank is a single embedded array, so Mongo reads the document whole
// either way; what pagination removes is the transfer and the render, the same
// trade getAllOtherPlatformQuestions below already makes.
exports.getAllQuestionsbank = async (req, res) => {
  try {
    const {
      questionType,
      category,
      difficulty,
      isActive,
      page, limit, search, createdBy, marks, createdAfter,
    } = req.query;

    const institutionId = req.user?.institution?._id || req.user?.institution;

    if (!institutionId) {
      return res.status(400).json({
        success: false,
        message: 'User institution not found'
      });
    }

    // NOTE: a `query` object mirroring these filters used to be built here and
    // then never passed to anything — the filters have always been applied to
    // the embedded array in JS below, because one document holds every
    // question. Dropped rather than wired up: matching a document on
    // `questions.questionType` would return the whole bank whenever ANY
    // question matched, which is not what the JS filtering does.
    //
    // The previous `.populate('institution', 'inst_name inst_id')` was a
    // second DB round trip whose result was thrown away — the response echoes
    // `institutionId` from the token, never the populated document.
    const questionBank = await Question.findOne({ institution: institutionId });

    if (!questionBank) {
      // The paginated shape still has to carry its extra keys, or a page
      // pointed at an institution with no bank reads `undefined` for its
      // facets and renders no stat chips at all.
      if (page !== undefined) {
        return res.status(200).json({
          success: true,
          total: 0,
          bankTotal: 0,
          page: 1,
          limit: Math.min(5000, Math.max(1, parseInt(limit, 10) || 25)),
          totalPages: 1,
          institution: institutionId,
          questions: [],
          facets: {
            categories: [],
            createdBy: [],
            stats: { total: 0, mcq: 0, programming: 0, active: 0 },
          },
        });
      }
      return res.status(200).json({
        success: true,
        total: 0,
        institution: institutionId,
        questions: []
      });
    }

    // ── Legacy path — byte-identical to the pre-pagination response ──
    if (page === undefined) {
      let filteredQuestions = questionBank.questions || [];

      if (questionType) {
        filteredQuestions = filteredQuestions.filter(q => q.questionType === questionType);
      }
      if (category) {
        filteredQuestions = filteredQuestions.filter(q => q.questionCategory === category);
      }
      if (difficulty) {
        filteredQuestions = filteredQuestions.filter(q => q.mcqQuestionDifficulty === difficulty);
      }
      if (isActive !== undefined) {
        filteredQuestions = filteredQuestions.filter(q => q.isActive === (isActive === 'true'));
      }

      filteredQuestions.sort((a, b) => b.createdAt - a.createdAt);

      return res.status(200).json({
        success: true,
        total: filteredQuestions.length,
        institution: institutionId,
        questions: filteredQuestions
      });
    }

    // ── Paginated path ──
    const all = questionBank.questions || [];

    // Facets first, over the unfiltered bank.
    const categorySet = new Set();
    const createdBySet = new Set();
    let mcqCount = 0;
    let activeCount = 0;
    for (const q of all) {
      if (q.questionCategory) categorySet.add(q.questionCategory);
      if (q.createdBy) createdBySet.add(q.createdBy);
      if (isMcqType(q.questionType)) mcqCount += 1;
      if (q.isActive) activeCount += 1;
    }

    // The page lower-cases the raw search box value without trimming, and
    // applies the block on a truthy check — so a search of a single space is a
    // real filter that matches nothing. Kept.
    const hasSearch = typeof search === 'string' && search !== '';
    const term = lcOf(search);
    const wantedMarks = String(marks || '');
    // Epoch ms computed in the BROWSER: the presets ("last 7 days", "this
    // year") are derived from the user's local clock, so the cutoff cannot be
    // recomputed here without shifting the boundary by the server's offset.
    const cutoff = Number(createdAfter) > 0 ? Number(createdAfter) : 0;

    const rows = all.filter((q) => {
      // Same predicates, in the same order, as `filteredQuestions`.
      if (questionType) {
        // The dropdown offers the broad buckets MCQ / Programming, and
        // "Programming" means every non-MCQ sub-type (programming / frontend /
        // database) — not an equality test against the stored discriminator.
        if (questionType === 'MCQ' ? !isMcqType(q.questionType) : isMcqType(q.questionType)) return false;
      }
      if (category && q.questionCategory !== category) return false;
      // `q.difficulty` — NOT the legacy path's `mcqQuestionDifficulty`, which
      // is a different field. The page has always filtered on `difficulty`;
      // it just never sent the param, so the mismatch never surfaced.
      if (difficulty && q.difficulty !== difficulty) return false;
      if (isActive !== undefined && isActive !== '' && q.isActive !== (isActive === 'true')) return false;
      if (createdBy && q.createdBy !== createdBy) return false;
      if (wantedMarks && !inMarksRange(bankScoreOf(q), wantedMarks)) return false;
      if (cutoff) {
        const c = bankCreatedMs(q);
        if (!c || c < cutoff) return false;
      }
      if (hasSearch) {
        // Three independent field tests OR'd together — this is how the page
        // composes it, so a joined haystack would match a term spanning two
        // fields that the page itself would not.
        if (
          !lcOf(bankSearchTitle(q)).includes(term) &&
          !lcOf(q.description).includes(term) &&
          !lcOf(q.questionCategory).includes(term)
        ) return false;
      }
      return true;
    });

    // Newest first, as the legacy path sorted. The `_id` tie-break is what
    // makes a slice stable: 49 of this bank's 89 rows share a createdAt with
    // another row, and paging a partial order reshuffles. ASCENDING because
    // ObjectIds increase with insertion, so a tied group keeps the document
    // order V8's stable sort already gave it — the visible order is unchanged,
    // it is merely no longer dependent on the array's physical layout.
    rows.sort((a, b) => {
      const d = bankCreatedMs(b) - bankCreatedMs(a);
      if (d) return d;
      const ida = String(a._id);
      const idb = String(b._id);
      return ida < idb ? -1 : ida > idb ? 1 : 0;
    });

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    // The cap is generous because "Export all (CSV)" asks for the whole
    // filtered set in one call — an explicit full read, no larger than the
    // response this endpoint returned unconditionally before.
    const perPage = Math.min(5000, Math.max(1, parseInt(limit, 10) || 25));
    const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
    const safePage = Math.min(pageNum, totalPages);
    const start = (safePage - 1) * perPage;

    return res.status(200).json({
      success: true,
      total: rows.length,
      bankTotal: all.length,
      page: safePage,
      limit: perPage,
      totalPages,
      institution: institutionId,
      questions: rows.slice(start, start + perPage),
      facets: {
        categories: Array.from(categorySet).sort(),
        createdBy: Array.from(createdBySet).sort(),
        stats: {
          total: all.length,
          mcq: mcqCount,
          programming: all.length - mcqCount,
          active: activeCount,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching questions',
      error: error.message
    });
  }
};

// ── Picker helpers ───────────────────────────────────────────────────────────
// Ports of the QuestionBankSelector's own derivations, so a server-paginated
// page contains exactly the rows the client's predicate would have kept. They
// are deliberately verbatim (same field order, same fallbacks, same HTML
// stripping) — any drift here shows up as questions missing from a search.
const stripHtml = (s) => String(s == null ? '' : s).replace(/<[^>]*>/g, '').trim();

const blocksToText = (arr) =>
  arr
    .filter((cb) => cb && cb.type === 'text')
    .map((cb) => stripHtml(cb.value || ''))
    .filter(Boolean)
    .join(' ');

const pickerTitle = (q) => {
  const t = q.mcqQuestionTitle;
  if (t) {
    if (Array.isArray(t)) return blocksToText(t);
    if (typeof t === 'object' && t.text) return stripHtml(t.text);
    if (typeof t === 'string') return stripHtml(t);
  }
  const title = q.questionText || q.title || '';
  if (Array.isArray(title)) return blocksToText(title);
  if (typeof title === 'string') return stripHtml(title);
  return 'Untitled Question';
};

const pickerDescription = (q) => {
  if (String(q.questionType || '').toLowerCase() === 'mcq') {
    const d = q.mcqQuestionDescription;
    if (d) {
      if (Array.isArray(d)) return blocksToText(d);
      if (typeof d === 'object' && d.text) return stripHtml(d.text);
      if (typeof d === 'string') return stripHtml(d);
    }
    return 'Multiple Choice Question';
  }
  const d = q.description;
  if (typeof d === 'string') return stripHtml(d);
  if (d && typeof d === 'object') {
    if (Array.isArray(d)) return blocksToText(d);
    if (d.text) return stripHtml(d.text);
  }
  return '';
};

// `QB-XXXXXX` from the last six characters of the id — the picker lets you
// search by it, so the server has to be able to match it too.
const pickerQbId = (q) => `QB-${String(q._id || '').slice(-6).toUpperCase()}`;

const pickerDifficulty = (q) => {
  const d = String(q.difficulty || q.mcqQuestionDifficulty || 'medium').toLowerCase();
  return d === 'easy' || d === 'hard' ? d : 'medium';
};

const asArray = (v) => (Array.isArray(v) ? v : []);

// ── Other Platform bank ──────────────────────────────────────────────────────
// Top-level `OtherPlatformQuestion` collection — one document per question,
// replacing the legacy single-doc-with-embedded-array shape that was already
// at 9.2 MB of Mongo's 16 MB per-document cap. The response payload matches
// the legacy handler field-for-field so the picker keeps working unchanged.
//
// PAGINATION (opt-in via `page`): callers that DON'T pass `page` still get
// every matching question in the legacy response shape; callers that DO get
// one page + the picker's filter-rail facets.
//
// The `.lean()` prohibition at the top of this file applies here too — a
// lean read would drop the 11 schema-defaulted fields the picker consumes
// (topics, tags, source, timeComplexity, …) so the scope fetch runs hydrated.
exports.getAllOtherPlatformQuestions = async (req, res) => {
  try {
    const {
      questionType, category, difficulty, isActive,
      page, limit, search, problemTypes, topic, tag, sort,
    } = req.query;

    // Scope = the type-scoped set facets are counted over. The rail's search
    // and secondary filters (problemTypes / topic / tag / railDifficulty) are
    // applied AFTER the facets — same separation the legacy in-memory path
    // enforced.
    const scopeQuery = {};
    if (questionType) scopeQuery.questionType = questionType;
    if (category) scopeQuery.questionCategory = category;
    if (difficulty) scopeQuery.mcqQuestionDifficulty = difficulty;
    if (isActive !== undefined) scopeQuery.isActive = isActive === 'true';

    const scope = await Question.OtherPlatformQuestion
      .find(scopeQuery)
      .sort({ createdAt: -1 });

    // Legacy path — unchanged response shape.
    if (page === undefined) {
      return res.status(200).json({
        success: true,
        total: scope.length,
        institution: null,
        questions: scope
      });
    }

    const problemTypeCounts = {};
    const difficultyCounts = { easy: 0, medium: 0, hard: 0 };
    const topicSet = new Map();
    const tagSet = new Map();
    for (const q of scope) {
      const pt = q.problemType || '';
      if (pt) problemTypeCounts[pt] = (problemTypeCounts[pt] || 0) + 1;
      difficultyCounts[pickerDifficulty(q)] += 1;
      for (const t of asArray(q.topics)) {
        const k = String(t || '').trim().toLowerCase();
        if (k && !topicSet.has(k)) topicSet.set(k, String(t));
      }
      for (const t of asArray(q.tags)) {
        const k = String(t || '').trim().toLowerCase();
        if (k && !tagSet.has(k)) tagSet.set(k, String(t));
      }
    }

    const term = String(search || '').trim().toLowerCase();
    const wantedPts = String(problemTypes || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const wantedTopic = String(topic || '').trim().toLowerCase();
    const wantedTag = String(tag || '').trim().toLowerCase();
    const wantedDiff = String(req.query.railDifficulty || '').trim().toLowerCase();

    let rows = scope.filter((q) => {
      if (wantedPts.length > 0 && !wantedPts.includes(q.problemType || '')) return false;
      if (wantedDiff && pickerDifficulty(q) !== wantedDiff) return false;
      if (wantedTopic && !asArray(q.topics).some(t => String(t).trim().toLowerCase() === wantedTopic)) return false;
      if (wantedTag && !asArray(q.tags).some(t => String(t).trim().toLowerCase() === wantedTag)) return false;
      if (!term) return true;
      return (
        pickerTitle(q).toLowerCase().includes(term) ||
        pickerDescription(q).toLowerCase().includes(term) ||
        pickerQbId(q).toLowerCase().includes(term) ||
        String(q.problemType || '').toLowerCase().includes(term) ||
        asArray(q.topics).some(t => String(t).toLowerCase().includes(term)) ||
        asArray(q.tags).some(t => String(t).toLowerCase().includes(term))
      );
    });

    // 'relevance' keeps the newest-first order established above.
    if (sort === 'title') {
      rows = [...rows].sort((a, b) => pickerTitle(a).localeCompare(pickerTitle(b)));
    } else if (sort === 'difficulty') {
      const rank = { easy: 0, medium: 1, hard: 2 };
      rows = [...rows].sort((a, b) => rank[pickerDifficulty(a)] - rank[pickerDifficulty(b)]);
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(limit, 10) || 25));
    const start = (pageNum - 1) * perPage;

    // Admin-side facets: whole-collection totals, filter-independent, for the
    // External Question Bank page's header chips and its Category / Created By
    // dropdowns. Computed here rather than in a second round-trip. The picker
    // ignores these extra keys.
    const adminFacets = await Question.OtherPlatformQuestion.aggregate([
      {
        $facet: {
          stats: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                mcq: {
                  $sum: {
                    $cond: [{ $eq: [{ $toLower: '$questionType' }, 'mcq'] }, 1, 0],
                  },
                },
                programming: {
                  $sum: {
                    $cond: [
                      {
                        $in: [
                          { $toLower: '$questionType' },
                          ['programming', 'frontend', 'database'],
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                active: { $sum: { $cond: ['$isActive', 1, 0] } },
              },
            },
          ],
          categories: [
            { $match: { questionCategory: { $nin: [null, ''] } } },
            { $group: { _id: '$questionCategory' } },
            { $sort: { _id: 1 } },
          ],
          createdBy: [
            { $match: { createdBy: { $nin: [null, ''] } } },
            { $group: { _id: '$createdBy' } },
            { $sort: { _id: 1 } },
          ],
        },
      },
    ]);
    const admin = adminFacets[0] || { stats: [], categories: [], createdBy: [] };
    const adminStats = admin.stats[0] || { total: 0, mcq: 0, programming: 0, active: 0 };

    const sortLabel = (s) => String(s || '').trim();
    return res.status(200).json({
      success: true,
      total: rows.length,
      scopeTotal: scope.length,
      page: pageNum,
      limit: perPage,
      institution: null,
      questions: rows.slice(start, start + perPage),
      facets: {
        problemTypeCounts,
        difficultyCounts,
        topics: Array.from(topicSet, ([value, label]) => ({ value, label })),
        tags: Array.from(tagSet, ([value, label]) => ({ value, label })),
        stats: {
          total: adminStats.total,
          mcq: adminStats.mcq,
          programming: adminStats.programming,
          active: adminStats.active,
        },
        categories: admin.categories.map((c) => c._id).filter(Boolean),
        createdBy: admin.createdBy.map((c) => c._id).filter(Boolean),
      },
      sort: sortLabel(sort),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error fetching other platform questions',
      error: error.message
    });
  }
};

// Get single question by ID with institution check
exports.getQuestionBankById = async (req, res) => {
  try {
    const institutionId = req.user?.institution?._id || req.user?.institution;
    
    if (!institutionId) {
      return res.status(400).json({
        success: false,
        message: 'User institution not found'
      });
    }

    const questionBank = await Question.findOne({
      institution: institutionId,
      'questions._id': req.params.id
    })
      .populate('institution', 'name')
      .populate('questions.createdBy', 'name email')
      .populate('questions.updatedBy', 'name email');

    if (!questionBank) {
      return res.status(404).json({
        success: false,
        message: 'Question not found or you do not have access'
      });
    }

    const question = questionBank.questions.find(q => 
      q._id.toString() === req.params.id
    );

    if (!question) {
      return res.status(404).json({
        success: false,
        message: 'Question not found'
      });
    }

    res.status(200).json({
      success: true,
      question
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching question',
      error: error.message
    });
  }
};

// Update question with institution check - FIXED VERSION
exports.updateQuestionBank = async (req, res) => {
  try {
    const institutionId = req.user?.institution?._id || req.user?.institution;
    
    if (!institutionId) {
      return res.status(400).json({
        success: false,
        message: 'User institution not found'
      });
    }

    const { id } = req.params; // This is the question ID to update
    
    // Parse questionsData from FormData
    let questionsData = [];
    
    if (req.body.questionsData) {
      if (typeof req.body.questionsData === 'string') {
        try {
          questionsData = JSON.parse(req.body.questionsData);
          console.log('✅ Parsed questionsData for update:', questionsData.length, 'questions');
        } catch (e) {
          return res.status(400).json({
            success: false,
            message: 'Invalid questionsData format - must be valid JSON array'
          });
        }
      } else if (Array.isArray(req.body.questionsData)) {
        questionsData = req.body.questionsData;
      }
    } else if (Array.isArray(req.body)) {
      questionsData = req.body;
    } else if (req.body.questionType) {
      questionsData = [req.body];
    }

    if (!Array.isArray(questionsData) || questionsData.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'questionsData must be a non-empty array for update'
      });
    }

    // Get the existing question bank
    const questionBank = await Question.findOne({ institution: institutionId });
    
    if (!questionBank) {
      return res.status(404).json({
        success: false,
        message: 'Question bank not found for this institution'
      });
    }

    // Find the existing question index
    const existingQuestionIndex = questionBank.questions.findIndex(
      q => q._id.toString() === id
    );

    if (existingQuestionIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Question not found in the question bank'
      });
    }

    // Get the question data (should be the first/only question in the array for update)
    let question = questionsData[0];
    
    // Normalize the question data first
    question = normalizeMCQQuestion(question);
    
    const isMCQ = question.questionType === 'MCQ' || 
                  question.questionType === 'mcq' ||
                  question.mcqQuestionTitle || 
                  question.mcqQuestionType;

    let processedQuestion;

    if (isMCQ) {
      console.log(`📝 Updating MCQ Question with ID: ${id}`);
      
      // Handle mcqQuestionTitle as object (already normalized)
      let mcqTitleObj = question.mcqQuestionTitle || { text: '' };
      
      if (typeof mcqTitleObj === 'string') {
        mcqTitleObj = { text: mcqTitleObj };
      }

      // Handle mcqQuestionDescription as object (already normalized)
      let mcqDescriptionObj = question.mcqQuestionDescription || null;
      
      if (mcqDescriptionObj && typeof mcqDescriptionObj === 'string') {
        mcqDescriptionObj = { text: mcqDescriptionObj };
      }

      const mcqType = question.mcqQuestionType || 'multiple_choice';
      const mcqOptions = question.mcqQuestionOptions || question.options || [];
      const mcqCorrectAnswers = question.mcqQuestionCorrectAnswers || 
                               question.correctAnswers || 
                               (question.correctAnswer ? [question.correctAnswer] : []);
      
      // Process mcqQuestionTitle image upload
      let titleImageUrl = mcqTitleObj.imageUrl || null;
      const titleImageField = `question_0_image`;
      const titleImageFile = req.files?.[titleImageField];

      // Check if it's a new image upload or existing URL
      if (titleImageFile) {
        try {
          titleImageUrl = await uploadImageToSupabase(
            titleImageFile,
            `mcq/title/${Date.now()}_update`
          );
          console.log(`✅ Uploaded title image for update:`, titleImageUrl);
        } catch (uploadError) {
          console.error(`Error uploading title image:`, uploadError);
        }
      } else if (titleImageUrl && titleImageUrl.startsWith('data:')) {
        // Handle base64 image
        try {
          const fileName = `title_${Date.now()}_update.jpg`;
          const imageFile = {
            name: fileName,
            data: Buffer.from(titleImageUrl.split(',')[1], 'base64'),
            mimetype: 'image/jpeg'
          };
          titleImageUrl = await uploadImageToSupabase(imageFile, `mcq/title/${Date.now()}_update`);
          console.log(`✅ Uploaded base64 title image:`, titleImageUrl);
        } catch (uploadError) {
          console.error(`Error uploading base64 title image:`, uploadError);
        }
      }

      // Process mcqQuestionDescription image upload
      let descriptionImageUrl = mcqDescriptionObj?.imageUrl || null;
      const descriptionImageField = `question_0_explanation_image`;
      const descriptionImageFile = req.files?.[descriptionImageField];

      if (descriptionImageFile) {
        try {
          descriptionImageUrl = await uploadImageToSupabase(
            descriptionImageFile,
            `mcq/description/${Date.now()}_update`
          );
          console.log(`✅ Uploaded description image for update:`, descriptionImageUrl);
        } catch (uploadError) {
          console.error(`Error uploading description image:`, uploadError);
        }
      }

      // Process options with images
      let processedOptions = [];
      const choiceBasedTypes = ['multiple_choice', 'multiple_select', 'dropdown'];
      
      if (choiceBasedTypes.includes(mcqType)) {
        processedOptions = await Promise.all(
          mcqOptions.map(async (option, optIndex) => {
            let imageUrl = option.imageUrl || null;
            
            const imageField = `question_0_option_${optIndex}_image`;
            const imageFile = req.files?.[imageField];

            if (imageFile) {
              try {
                imageUrl = await uploadImageToSupabase(
                  imageFile,
                  `mcq/option/${Date.now()}_update_${optIndex}`
                );
                console.log(`✅ Uploaded option ${optIndex} image for update:`, imageUrl);
              } catch (uploadError) {
                console.error(`Error uploading option image:`, uploadError);
              }
            } else if (imageUrl && imageUrl.startsWith('data:')) {
              // Handle base64 image
              try {
                const fileName = `option_${Date.now()}_update_${optIndex}.jpg`;
                const imageFile = {
                  name: fileName,
                  data: Buffer.from(imageUrl.split(',')[1], 'base64'),
                  mimetype: 'image/jpeg'
                };
                imageUrl = await uploadImageToSupabase(imageFile, `mcq/option/${Date.now()}_update_${optIndex}`);
                console.log(`✅ Uploaded base64 option image:`, imageUrl);
              } catch (uploadError) {
                console.error(`Error uploading base64 option image:`, uploadError);
              }
            }

            return {
              _id: option._id || new mongoose.Types.ObjectId(),
              text: option.text || '',
              isCorrect: option.isCorrect || false,
              imageUrl: imageUrl,
              imageAlignment: option.imageAlignment || 'left',
              imageSizePercent: option.imageSizePercent || 100
            };
          })
        );
      }

      // Build final objects
      const finalMcqTitleObj = {
        text: mcqTitleObj.text,
        ...(titleImageUrl && { imageUrl: titleImageUrl }),
        ...(mcqTitleObj.imageAlignment && { imageAlignment: mcqTitleObj.imageAlignment }),
        ...(mcqTitleObj.imageSizePercent && { imageSizePercent: mcqTitleObj.imageSizePercent })
      };

      let finalMcqDescriptionObj = mcqDescriptionObj ? { ...mcqDescriptionObj } : null;
      if (descriptionImageUrl) {
        if (!finalMcqDescriptionObj) {
          finalMcqDescriptionObj = {};
        }
        finalMcqDescriptionObj.imageUrl = descriptionImageUrl;
        if (!finalMcqDescriptionObj.imageAlignment) finalMcqDescriptionObj.imageAlignment = 'center';
        if (!finalMcqDescriptionObj.imageSizePercent) finalMcqDescriptionObj.imageSizePercent = 60;
      }

      // Get the existing question to preserve createdBy and createdAt
      const existingQuestion = questionBank.questions[existingQuestionIndex];
      
      // Build the processed question object - PRESERVE THE ORIGINAL _id
      processedQuestion = {
        _id: existingQuestion._id, // IMPORTANT: Keep the original ID
        questionCategory: question.questionCategory || existingQuestion.questionCategory || 'General',
        questionType: 'mcq',
        isActive: question.isActive !== undefined ? question.isActive : existingQuestion.isActive,
        mcqQuestionTitle: finalMcqTitleObj,
        ...(finalMcqDescriptionObj && finalMcqDescriptionObj.text && { mcqQuestionDescription: finalMcqDescriptionObj }),
        mcqQuestionType: mcqType,
        mcqQuestionDifficulty: question.mcqQuestionDifficulty || question.difficulty || existingQuestion.mcqQuestionDifficulty || 'medium',
        mcqQuestionScore: question.mcqQuestionScore || question.score || existingQuestion.mcqQuestionScore || 10,
        mcqQuestionTimeLimit: question.mcqQuestionTimeLimit || question.timeLimit || existingQuestion.mcqQuestionTimeLimit || 0,
        mcqQuestionOptionsPerRow: question.mcqQuestionOptionsPerRow || question.optionsPerRow || existingQuestion.mcqQuestionOptionsPerRow || 1,
        mcqQuestionRequired: question.mcqQuestionRequired === true || existingQuestion.mcqQuestionRequired === true,
        createdBy: existingQuestion.createdBy || req.user?.email || 'system',
        updatedBy: req.user?.email || 'system',
        createdAt: existingQuestion.createdAt || new Date(),
        updatedAt: new Date()
      };

      // Add type-specific fields
      if (choiceBasedTypes.includes(mcqType)) {
        processedQuestion.mcqQuestionOptions = processedOptions;
        processedQuestion.mcqQuestionCorrectAnswers = mcqCorrectAnswers;
      }

      if (mcqType === 'true_false') {
        processedQuestion.trueFalseAnswer = question.trueFalseAnswer;
      }

      if (mcqType === 'short_answer') {
        processedQuestion.shortAnswer = question.shortAnswer || '';
      }

      if (mcqType === 'essay') {
        processedQuestion.essayAnswer = question.essayAnswer || '';
      }

      if (mcqType === 'matching') {
        processedQuestion.matchingPairs = (question.matchingPairs || []).map(p => ({
          _id: p._id || new mongoose.Types.ObjectId(),
          left: p.left || '',
          right: p.right || ''
        }));
      }

      if (mcqType === 'ordering') {
        processedQuestion.orderingItems = (question.orderingItems || []).map(item => ({
          _id: item._id || new mongoose.Types.ObjectId(),
          text: item.text || '',
          order: item.order || 0
        }));
      }

      if (mcqType === 'numeric') {
        processedQuestion.numericAnswer = question.numericAnswer;
        processedQuestion.numericTolerance = question.numericTolerance || null;
      }

      if (question.hasExplanation || (finalMcqDescriptionObj && finalMcqDescriptionObj.text)) {
        processedQuestion.hasExplanation = true;
        processedQuestion.explanation = finalMcqDescriptionObj?.text || question.explanation || '';
      }

    } else {
      // Programming question processing
      console.log(`📝 Updating Programming Question with ID: ${id}`);
      
      const existingQuestion = questionBank.questions[existingQuestionIndex];
      
      processedQuestion = {
        _id: existingQuestion._id, // IMPORTANT: Keep the original ID
        questionCategory: question.questionCategory || existingQuestion.questionCategory || 'Programming',
        // Specific sub-type: programming (core) / frontend / database.
        questionType: (question.questionType || existingQuestion.questionType || 'programming').toLowerCase(),
        title: question.title || existingQuestion.title,
        description: question.description || existingQuestion.description,
        difficulty: question.difficulty ? question.difficulty.charAt(0).toUpperCase() + question.difficulty.slice(1).toLowerCase() : existingQuestion.difficulty || 'medium',
        sampleInput: question.sampleInput || existingQuestion.sampleInput || '',
        sampleOutput: question.sampleOutput || existingQuestion.sampleOutput || '',
        // Database sub-type fields (were previously dropped).
        sampleQuery: question.sampleQuery !== undefined ? question.sampleQuery : (existingQuestion.sampleQuery || ''),
        expectedResult: question.expectedResult !== undefined ? question.expectedResult : (existingQuestion.expectedResult || ''),
        score: question.score || existingQuestion.score || 0,
        constraints: question.constraints || existingQuestion.constraints || [],
        hints: (question.hints || existingQuestion.hints || []).map((h, idx) => ({
          _id: h._id || new mongoose.Types.ObjectId(),
          hintText: h.hintText || '',
          pointsDeduction: h.pointsDeduction || 0,
          isPublic: h.isPublic || false,
          sequence: h.sequence || idx
        })),
        testCases: (question.testCases || existingQuestion.testCases || []).map(tc => ({
          _id: tc._id || new mongoose.Types.ObjectId(),
          input: tc.input || '',
          expectedOutput: tc.expectedOutput || '',
          isSample: tc.isSample || false,
          isHidden: tc.isHidden || false,
          points: tc.points || 0,
          explanation: tc.explanation || ''
        })),
        solutions: (question.solutions || existingQuestion.solutions) ? {
          _id: (question.solutions || existingQuestion.solutions)?._id || new mongoose.Types.ObjectId(),
          startedCode: (question.solutions || existingQuestion.solutions)?.startedCode || '',
          functionName: (question.solutions || existingQuestion.solutions)?.functionName || '',
          language: (question.solutions || existingQuestion.solutions)?.language || 'javascript'
        } : null,
        timeLimit: question.timeLimit || existingQuestion.timeLimit || 2000,
        memoryLimit: question.memoryLimit || existingQuestion.memoryLimit || 256,
        isActive: question.isActive !== undefined ? question.isActive : existingQuestion.isActive,
        createdBy: existingQuestion.createdBy || req.user?.email || 'system',
        updatedBy: req.user?.email || 'system',
        createdAt: existingQuestion.createdAt || new Date(),
        updatedAt: new Date()
      };
    }

    // ── Classification metadata (shared by MCQ + programming) ──────────────
    // Preserve existing values when the payload doesn't send a field.
    {
      const cleanList = (v) => Array.isArray(v)
        ? v.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim())
        : null;
      const topics = cleanList(question.topics);
      const tags = cleanList(question.tags);
      processedQuestion.problemType = question.problemType !== undefined ? (question.problemType || null) : (existingQuestion.problemType || null);
      processedQuestion.topics = topics !== null ? topics : (existingQuestion.topics || []);
      processedQuestion.tags = tags !== null ? tags : (existingQuestion.tags || []);
      processedQuestion.timeComplexity = question.timeComplexity !== undefined ? String(question.timeComplexity || '') : (existingQuestion.timeComplexity || '');
      processedQuestion.spaceComplexity = question.spaceComplexity !== undefined ? String(question.spaceComplexity || '') : (existingQuestion.spaceComplexity || '');
      processedQuestion.outputCode = question.outputCode !== undefined ? String(question.outputCode || '') : (existingQuestion.outputCode || '');
      processedQuestion.hasOtherOption = question.hasOtherOption !== undefined ? question.hasOtherOption === true : (existingQuestion.hasOtherOption === true);
      processedQuestion.source = question.source || existingQuestion.source || null;
      // Whole-subdoc rebuild — carry provenance fields forward or they vanish.
      processedQuestion.createdByEmail = existingQuestion.createdByEmail || undefined;
      processedQuestion._clonedFromExercise = existingQuestion._clonedFromExercise || undefined;
      processedQuestion._clonedFromExerciseQuestionId = existingQuestion._clonedFromExerciseQuestionId || undefined;
    }

    // Remove undefined fields
    Object.keys(processedQuestion).forEach(key => {
      if (processedQuestion[key] === undefined || processedQuestion[key] === null) {
        delete processedQuestion[key];
      }
    });

    // Update the specific question in the array
    questionBank.questions[existingQuestionIndex] = processedQuestion;
    await questionBank.save();
    
    console.log(`✅ Updated question with ID: ${id} successfully`);

    return res.status(200).json({
      success: true,
      message: 'Question updated successfully',
      data: {
        questionBankId: questionBank._id.toString(),
        totalQuestionsInBank: questionBank.questions.length,
        updatedQuestion: processedQuestion
      }
    });

  } catch (error) {
    console.error("❌ Error updating question:", error);
    return res.status(500).json({
      success: false,
      message: 'Error updating question in question bank',
      error: error.message
    });
  }
};

// Delete question (soft delete) with institution check
exports.deleteQuestionBank = async (req, res) => {
  try {
    const institutionId = req.user?.institution?._id || req.user?.institution;
    
    if (!institutionId) {
      return res.status(400).json({
        success: false,
        message: 'User institution not found'
      });
    }

    // updateOne, not findOneAndUpdate({new:true}): the returned document was
    // only used to re-scan the whole (now shorter) questions[] array for the
    // id that was just pulled. `$pull` removes every matching element
    // atomically, so that scan could never find one — the branch it guarded
    // was unreachable and the full-array hydration was pure cost.
    //
    // Behavior preserved deliberately: deleting an id that isn't in the bank
    // still reports success (matchedCount is 1, the $pull is simply a no-op),
    // exactly as before. Only a missing bank 404s.
    const result = await Question.updateOne(
      { institution: institutionId },
      { $pull: { questions: { _id: req.params.id } } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Question bank not found for this institution'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Question deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error deleting question',
      error: error.message
    });
  }
};

// Toggle question status
exports.toggleQuestionStatus = async (req, res) => {
  try {
    const { questionId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isActive must be a boolean value',
      });
    }

    // Institution scoping — without it any authenticated user could flip
    // questions belonging to another tenant by guessing ids.
    const institutionId = req.user?.institution?._id || req.user?.institution;
    if (!institutionId) {
      return res.status(400).json({
        success: false,
        message: 'User institution not found',
      });
    }

    // One round trip, not two: this used to run an identical findOne purely to
    // decide whether to 404, then re-run the same filter as findOneAndUpdate —
    // which already returns null when nothing matches. Merging them also
    // closes the gap where a question deleted between the two queries reported
    // 'Failed to update question status' instead of 'Question not found'.
    //
    // The whole questions[] array still comes back because MongoDB rejects a
    // positional projection together with returning the post-update document
    // ("cannot use a positional projection and return the new document"), and
    // the response's `data` must be the UPDATED question — verified against
    // the live server, not assumed.
    const result = await Question.findOneAndUpdate(
      { institution: institutionId, 'questions._id': questionId },
      {
        $set: {
          'questions.$.isActive': isActive,
          'questions.$.updatedAt': new Date().toISOString()
        }
      },
      { new: true, runValidators: true }
    ).select('questions');

    if (!result) {
      return res.status(404).json({
        success: false,
        message: 'Question not found',
      });
    }

    const updatedQuestion = result.questions.find(q => q._id.toString() === questionId);

    res.status(200).json({
      success: true,
      message: `Question ${isActive ? 'activated' : 'deactivated'} successfully`,
      data: updatedQuestion,
    });
  } catch (error) {
    console.error('Error toggling question status:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating question status',
      error: error.message,
    });
  }
};

// ── Other Platform bank — Create / Update / Delete / Toggle ─────────────────
// The bank is GLOBAL (no institution scope). Role gating on the routes limits
// writes to admin + super_admin — no exercise-question path uses these.

const stampAuthor = (req) => {
  const first = req.user?.firstName || '';
  const last = req.user?.lastName || '';
  const full = `${first}${last ? ' ' + last : ''}`.trim();
  return full || req.user?.email || 'admin';
};

exports.createOtherPlatformQuestion = async (req, res) => {
  try {
    const payload = cleanEmptyFields({ ...(req.body || {}) });
    payload.createdBy = stampAuthor(req);
    payload.createdByEmail = req.user?.email || '';

    const doc = await Question.OtherPlatformQuestion.create(payload);
    return res.status(201).json({
      success: true,
      message: 'Question created successfully',
      question: doc,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error creating other-platform question',
      error: error.message,
    });
  }
};

exports.updateOtherPlatformQuestion = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid question id' });
    }
    const payload = cleanEmptyFields({ ...(req.body || {}) });
    payload.updatedBy = stampAuthor(req);

    const doc = await Question.OtherPlatformQuestion.findByIdAndUpdate(
      id,
      { $set: payload },
      { new: true, runValidators: true },
    );
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Question not found' });
    }
    return res.status(200).json({
      success: true,
      message: 'Question updated successfully',
      question: doc,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error updating other-platform question',
      error: error.message,
    });
  }
};

exports.deleteOtherPlatformQuestion = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid question id' });
    }
    const doc = await Question.OtherPlatformQuestion.findByIdAndDelete(id);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Question not found' });
    }
    return res.status(200).json({ success: true, message: 'Question deleted successfully' });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error deleting other-platform question',
      error: error.message,
    });
  }
};

exports.toggleOtherPlatformQuestionStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid question id' });
    }
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ success: false, message: 'isActive must be boolean' });
    }
    const doc = await Question.OtherPlatformQuestion.findByIdAndUpdate(
      id,
      { $set: { isActive, updatedAt: new Date().toISOString() } },
      { new: true },
    );
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Question not found' });
    }
    return res.status(200).json({
      success: true,
      message: `Question ${isActive ? 'activated' : 'deactivated'} successfully`,
      data: doc,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Server error while updating question status',
      error: error.message,
    });
  }
};