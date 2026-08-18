const mongoose = require("mongoose");
const Module1 = mongoose.model('Module1');
const SubModule1 = mongoose.model('SubModule1');
const Topic1 = mongoose.model('Topic1');
const SubTopic1 = mongoose.model('SubTopic1');

// Resources by Batch — Test Your Skills stores its tests inside pedagogy.You_Do,
// so it resolves its container exactly like the rest of You Do. Shared with
// pedagogyView.js and exerciseAndQuestion.js so all three pedagogy sections
// agree on which batch a request belongs to.
const { resolvePedagogyScope } = require("../../../utils/pedagogyScope");

const modelMap = {
  modules: { model: Module1, path: "modules" },
  submodules: { model: SubModule1, path: "submodules" },
  topics: { model: Topic1, path: "topics" },
  subtopics: { model: SubTopic1, path: "subtopics" },
};

// Helper function to process base64 images in options
async function processOptionImages(options, entityId, itemKey, questionId) {
  const processedOptions = [];
  
  for (let optIndex = 0; optIndex < options.length; optIndex++) {
    const option = options[optIndex];
    let optionText = '';
    let isCorrect = false;
    let imageUrl = null;
    let imageAlignment = 'left';
    let imageSizePercent = 100;

    if (typeof option === 'string') {
      optionText = option;
      isCorrect = false;
    } else if (typeof option === 'object' && option !== null) {
      optionText = option.text || '';
      isCorrect = option.isCorrect || false;
      imageUrl = option.imageUrl || null;
      imageAlignment = option.imageAlignment || 'left';
      imageSizePercent = option.imageSizePercent || 100;

      // Handle base64 image if present
      if (option.imageUrl && option.imageUrl.startsWith('data:image')) {
        try {
          const base64Data = option.imageUrl.split(',')[1];
          const buffer = Buffer.from(base64Data, 'base64');
          const fileName = `mcq_option_${Date.now()}_${optIndex}.png`;
          const filePath = `${entityId}/${itemKey}/${questionId}/options/${fileName}`;
          
          const uploadedImageUrl = await uploadBufferToSupabase(
            buffer,
            filePath,
            'image/png'
          );
          imageUrl = uploadedImageUrl;
        } catch (uploadError) {
          console.error(`Error uploading base64 image for option ${optIndex}:`, uploadError);
        }
      }
    }

    processedOptions.push({
      text: optionText,
      isCorrect: isCorrect,
      imageUrl: imageUrl,
      imageAlignment: imageAlignment,
      imageSizePercent: imageSizePercent
    });
  }
  
  return processedOptions;
}

// Helper function to get or create You_Do item
async function getOrCreateYouDoItem(pedagogyRoot, itemKey, itemTitle) {
  if (!pedagogyRoot.You_Do) {
    pedagogyRoot.You_Do = new Map();
  }
  
  let youDoItem = pedagogyRoot.You_Do.get(itemKey);
  
  if (!youDoItem) {
    // Create new direct questions item
    youDoItem = {
      type: "direct_questions",
      data: {
        title: itemTitle,
        description: "",
        questionList: [],
        timeLimit: 0,
        passingScore: 70,
        attemptLimit: 1,
        shuffleQuestions: false,
        showResults: true,
        pointsPerQuestion: 1,
        totalPoints: 0,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    };
    pedagogyRoot.You_Do.set(itemKey, youDoItem);
  }
  
  return youDoItem;
}
// Helper function to process mixed content blocks for mcqQuestionTitle
async function processMixedContent(contentBlocks, entityId, itemKey, questionId) {
  if (!contentBlocks || !Array.isArray(contentBlocks)) {
    return contentBlocks; // Return as is if not array
  }
  
  const processedBlocks = [];
  
  for (let i = 0; i < contentBlocks.length; i++) {
    const block = contentBlocks[i];
    
    if (block.type === 'text') {
      // Text block - keep as is
      processedBlocks.push({
        id: block.id || generateId('txt'),
        type: 'text',
        value: block.value || ''
      });
    } 
    else if (block.type === 'code') {
      // Code block - keep as is
      processedBlocks.push({
        id: block.id || generateId('code'),
        type: 'code',
        value: block.value || '',
        bgColor: block.bgColor || '#1e1e1e',
        language: block.language || ''
      });
    }
    else if (block.type === 'image') {
      // Image block - handle base64 upload
      let imageUrl = block.url;
      
      if (block.url && block.url.startsWith('data:image')) {
        try {
          const base64Data = block.url.split(',')[1];
          const buffer = Buffer.from(base64Data, 'base64');
          const fileName = `content_image_${Date.now()}_${i}.png`;
          const filePath = `${entityId}/${itemKey}/${questionId}/content/${fileName}`;
          
          const uploadedImageUrl = await uploadBufferToSupabase(buffer, filePath, 'image/png');
          imageUrl = uploadedImageUrl;
        } catch (uploadError) {
          console.error(`Error uploading content image:`, uploadError);
        }
      }
      
      processedBlocks.push({
        id: block.id || generateId('img'),
        type: 'image',
        url: imageUrl,
        alignment: block.alignment || 'center',
        sizePercent: block.sizePercent || 60
      });
    }
  }
  
  return processedBlocks;
}

// Helper function to generate ID
function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
exports.addMcqToYouDo = async (req, res) => {
  console.log("🚀 [addMcqToYouDo] Starting request processing");
  
  try {
    const { type, id, itemKey } = req.params;
    const {
      questionsData,
      timeLimit,
      passingScore,
      attemptLimit,
      shuffleQuestions,
      showResults,
      pointsPerQuestion,
    } = req.body;

    console.log("📋 Request params:", { type, id, itemKey });
    console.log("📦 Questions count:", questionsData?.length);

    // Validate required parameters
    if (!type || !modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}` }]
      });
    }

    if (!itemKey) {
      return res.status(400).json({
        message: [{ key: "error", value: "itemKey is required (e.g., 'test_your_skills')" }]
      });
    }

    // Check if we have questions
    const isMultipleQuestions = Array.isArray(questionsData) && questionsData.length > 0;
    const questionsToAdd = isMultipleQuestions ? questionsData : [req.body];

    if (questionsToAdd.length === 0) {
      return res.status(400).json({
        message: [{ key: "error", value: "At least one question is required" }]
      });
    }

    // Get the model
    const { model } = modelMap[type];
    const entity = await model.findById(id);

    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} with ID ${id} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Test Your Skills is a You Do feature, so it obeys the same rule as the
    // rest of You Do: a shared course keeps its material on the course-level
    // `pedagogy`, a batch-wise one on this batch's `batchPedagogy.<batchId>`.
    // This also removes a latent crash — the code below read
    // `entity.pedagogy.You_Do` with no guard on `entity.pedagogy` itself, and
    // a node that has never had anything uploaded has no `pedagogy` subdoc at
    // all. resolvePedagogyScope always returns a container.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, "You_Do", req);


    // Initialize You_Do if not exists
    if (!pedagogyRoot.You_Do) {
      pedagogyRoot.You_Do = new Map();
    }

    // Get existing test or create new structure
    let existingTest = pedagogyRoot.You_Do.get(itemKey);
    
    if (!existingTest) {
      // Create new test structure
      existingTest = {
        questions: [],
        timeLimit: timeLimit || 60,
        passingScore: passingScore || 70,
        attemptLimit: attemptLimit || 1,
        shuffleQuestions: shuffleQuestions !== undefined ? shuffleQuestions : false,
        showResults: showResults !== undefined ? showResults : true,
        pointsPerQuestion: pointsPerQuestion || 1,
        totalPoints: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      };
    } else {
      // Update existing test settings
      existingTest.updatedAt = new Date();
      if (timeLimit !== undefined) existingTest.timeLimit = timeLimit;
      if (passingScore !== undefined) existingTest.passingScore = passingScore;
      if (attemptLimit !== undefined) existingTest.attemptLimit = attemptLimit;
      if (shuffleQuestions !== undefined) existingTest.shuffleQuestions = shuffleQuestions;
      if (showResults !== undefined) existingTest.showResults = showResults;
      if (pointsPerQuestion !== undefined) existingTest.pointsPerQuestion = pointsPerQuestion;
    }

    // Ensure questions array exists
    if (!existingTest.questions) {
      existingTest.questions = [];
    }

    // Get the starting sequence number
    const startSequence = existingTest.questions.length;
    const addedQuestions = [];

    // Process each question
    for (let i = 0; i < questionsToAdd.length; i++) {
      const questionData = questionsToAdd[i];
      const questionId = new mongoose.Types.ObjectId();
      
      console.log(`📝 Processing question ${i + 1}:`, questionData.mcqQuestionTitle);
      
      // Process mcqQuestionTitle (can be string OR array of content blocks)
      let processedTitle = questionData.mcqQuestionTitle;
      let extractedText = '';
      
      if (Array.isArray(questionData.mcqQuestionTitle)) {
        // Handle mixed content blocks
        processedTitle = await processMixedContent(
          questionData.mcqQuestionTitle,
          entity._id.toString(),
          itemKey,
          questionId
        );
        
        // Extract plain text for indexing/searching
        extractedText = questionData.mcqQuestionTitle
          .filter(block => block.type === 'text')
          .map(block => (block.value || '').replace(/<[^>]*>/g, '').trim())
          .join(' ')
          .substring(0, 500);
      } else if (typeof questionData.mcqQuestionTitle === 'string') {
        // Handle simple string
        extractedText = questionData.mcqQuestionTitle;
        processedTitle = questionData.mcqQuestionTitle;
      }
      
      // Validate title
      if (!extractedText && !processedTitle) {
        return res.status(400).json({
          message: [{ key: "error", value: `Question ${i + 1}: mcqQuestionTitle is required` }]
        });
      }

      // Get question type
      const mcqSubType = questionData.mcqQuestionType || "multiple_choice";
      
      // ========== VALIDATION BASED ON QUESTION TYPE ==========
      
      // For matching questions
      if (mcqSubType === 'matching') {
        const matchingPairs = questionData.matchingPairs || [];
        
        const hasValidPairs = matchingPairs.length > 0 && 
          matchingPairs.some(pair => pair.left && pair.left.trim() !== '' && 
                                    pair.right && pair.right.trim() !== '');
        
        if (!hasValidPairs) {
          return res.status(400).json({
            message: [{ key: "error", value: `Question ${i + 1}: At least one valid matching pair is required (both left and right values must be provided)` }]
          });
        }
      } 
      // For ordering questions
      else if (mcqSubType === 'ordering') {
        const orderingItems = questionData.orderingItems || [];
        
        const hasValidItems = orderingItems.length > 0 && 
          orderingItems.some(item => item.text && item.text.trim() !== '');
        
        if (!hasValidItems) {
          return res.status(400).json({
            message: [{ key: "error", value: `Question ${i + 1}: At least one valid ordering item is required` }]
          });
        }
      }
      // For regular MCQ types
      else {
        // Validate options for MCQ types
        const options = questionData.mcqQuestionOptions;
        
        if (['multiple_choice', 'multiple_select', 'dropdown'].includes(mcqSubType)) {
          if (!Array.isArray(options) || options.length < 2) {
            return res.status(400).json({
              message: [{ key: "error", value: `Question ${i + 1}: At least 2 options are required` }]
            });
          }
        }
        
        // Validate correct answers for different subtypes
        let correctAnswers = questionData.mcqQuestionCorrectAnswers;
        
        if (mcqSubType === 'short_answer') {
          // Short answer validation
          if (!correctAnswers || correctAnswers.length === 0 || !correctAnswers[0] || correctAnswers[0].trim() === '') {
            return res.status(400).json({
              message: [{ key: "error", value: `Question ${i + 1}: Correct answer is required for short answer question` }]
            });
          }
        } 
        else if (mcqSubType === 'numeric') {
          // Numeric validation
          if (!correctAnswers || correctAnswers.length === 0 || isNaN(parseFloat(correctAnswers[0]))) {
            return res.status(400).json({
              message: [{ key: "error", value: `Question ${i + 1}: Valid numeric answer is required for numeric question` }]
            });
          }
        }
        else if (mcqSubType === 'true_false') {
          // True/False validation
          if (!correctAnswers || correctAnswers.length === 0 || 
              (correctAnswers[0] !== 'true' && correctAnswers[0] !== 'false' && 
               correctAnswers[0] !== true && correctAnswers[0] !== false)) {
            return res.status(400).json({
              message: [{ key: "error", value: `Question ${i + 1}: True/False answer must be either 'true' or 'false'` }]
            });
          }
        }
        else if (mcqSubType !== 'essay' && mcqSubType !== 'paragraph') {
          // Default validation for other types
          if (!correctAnswers || correctAnswers.length === 0) {
            return res.status(400).json({
              message: [{ key: "error", value: `Question ${i + 1}: At least one correct answer is required` }]
            });
          }
        }
      }
      
      // ========== END OF VALIDATION ==========
      
      // Process options if they exist (only for MCQ types)
      let processedOptions = [];
      const options = questionData.mcqQuestionOptions;
      if (options && Array.isArray(options) && options.length > 0) {
        processedOptions = await processOptionImages(
          options,
          entity._id.toString(),
          itemKey,
          questionId
        );
      }
      
      // Ensure correctAnswers is defined (might be undefined for matching/ordering)
      let correctAnswers = questionData.mcqQuestionCorrectAnswers || [];
      
      // For matching and ordering, ensure correctAnswers is empty array
      if (mcqSubType === 'matching' || mcqSubType === 'ordering') {
        correctAnswers = [];
      }
      
      // Type mapping from frontend to backend
      const typeMapping = {
        'multiple_choice': 'multiple_choice',
        'multiple-choice': 'multiple_choice',
        'multiple_select': 'multiple_select',
        'multiple-select': 'multiple_select',
        'true_false': 'true_false',
        'true-false': 'true_false',
        'short_answer': 'short_answer',
        'short-answer': 'short_answer',
        'essay': 'essay',
        'paragraph': 'essay',
        'matching': 'matching',
        'ordering': 'ordering',
        'numeric': 'numeric',
        'dropdown': 'dropdown'
      };
      
      const backendType = typeMapping[mcqSubType] || "multiple_choice";

      // Process mcqQuestionDescription if it's mixed content
      let processedDescription = questionData.mcqQuestionDescription || "";
      if (Array.isArray(questionData.mcqQuestionDescription)) {
        const descBlocks = await processMixedContent(
          questionData.mcqQuestionDescription,
          entity._id.toString(),
          itemKey,
          questionId
        );
        processedDescription = descBlocks;
      }

      // Process matching pairs (ensure they have proper structure)
      let processedMatchingPairs = [];
      if (mcqSubType === 'matching' && questionData.matchingPairs) {
        processedMatchingPairs = questionData.matchingPairs.map((pair, idx) => ({
          id: pair.id || `pair_${idx}`,
          left: pair.left || '',
          right: pair.right || ''
        }));
      }
      
      // Process ordering items (ensure they have proper structure)
      let processedOrderingItems = [];
      if (mcqSubType === 'ordering' && questionData.orderingItems) {
        processedOrderingItems = questionData.orderingItems.map((item, idx) => ({
          id: item.id || `item_${idx}`,
          text: item.text || '',
          order: item.order || idx + 1
        }));
      }

      // Create question object matching the schema
      const newQuestion = {
        _id: questionId,
        questionType: "mcq",
        mcqQuestionTitle: processedTitle,
        mcqQuestionDescription: processedDescription,
        mcqQuestionType: backendType,
        mcqQuestionDifficulty: questionData.mcqQuestionDifficulty || "medium",
        mcqQuestionScore: questionData.mcqQuestionScore || existingTest.pointsPerQuestion || 1,
        mcqQuestionOptions: processedOptions,
        mcqQuestionCorrectAnswers: correctAnswers,
        mcqQuestionOptionsPerRow: questionData.mcqQuestionOptionsPerRow || 1,
        mcqQuestionRequired: questionData.mcqQuestionRequired !== undefined ? questionData.mcqQuestionRequired : true,
        hasOtherOption: questionData.hasOtherOption || false,
        hasExplanation: questionData.hasExplanation || false,
        isActive: questionData.isActive !== undefined ? questionData.isActive : true,
        sequence: startSequence + i,
        
        // Image fields for question
        mcqQuestionImageUrl: questionData.mcqQuestionImageUrl || null,
        mcqQuestionImageAlignment: questionData.mcqQuestionImageAlignment || "left",
        mcqQuestionImageSizePercent: questionData.mcqQuestionImageSizePercent || 100,
        
        // Explanation
        explanation: questionData.explanation || "",
        
        // For true_false
        trueFalseAnswer: backendType === "true_false" ? 
          (correctAnswers?.[0] === "true" || correctAnswers?.[0] === true) : null,
        
        // For short_answer
        shortAnswer: backendType === "short_answer" ?
          (correctAnswers?.[0] || "") : "",

        // For essay — sample/model answer used for auto-correction
        essayAnswer: backendType === "essay" ?
          (questionData.essayAnswer || correctAnswers?.[0] || "") : "",

        // For numeric
        numericAnswer: backendType === "numeric" ? 
          (parseFloat(correctAnswers?.[0]) || null) : null,
        numericTolerance: questionData.numericTolerance || null,
        
        // For matching and ordering
        matchingPairs: processedMatchingPairs,
        orderingItems: processedOrderingItems,
        
        // Store extracted text for search purposes
        _searchText: extractedText,
        
        // Timestamps
        createdAt: new Date(),
        updatedAt: new Date()
      };
      
      // Handle base64 image in question if present (legacy support)
      if (questionData.mcqQuestionImageUrl && questionData.mcqQuestionImageUrl.startsWith('data:image')) {
        try {
          const base64Data = questionData.mcqQuestionImageUrl.split(',')[1];
          const buffer = Buffer.from(base64Data, 'base64');
          const fileName = `question_image_${Date.now()}.png`;
          const filePath = `${entity._id}/${itemKey}/${newQuestion._id}/${fileName}`;
          
          const uploadedImageUrl = await uploadBufferToSupabase(buffer, filePath, 'image/png');
          newQuestion.mcqQuestionImageUrl = uploadedImageUrl;
        } catch (uploadError) {
          console.error(`Error uploading question image:`, uploadError);
        }
      }
      
      // Add to questions array
      existingTest.questions.push(newQuestion);
      addedQuestions.push({
        id: newQuestion._id,
        title: typeof newQuestion.mcqQuestionTitle === 'string' 
          ? newQuestion.mcqQuestionTitle 
          : (newQuestion.mcqQuestionTitle.find(b => b.type === 'text')?.value || 'Question'),
        type: newQuestion.mcqQuestionType,
        sequence: startSequence + i,
        score: newQuestion.mcqQuestionScore
      });
      
      console.log(`✅ Question ${i + 1} added with ID: ${questionId}`);
    }
    
    // Recalculate total points
    existingTest.totalPoints = existingTest.questions.reduce(
      (sum, q) => sum + (q.mcqQuestionScore || existingTest.pointsPerQuestion || 1),
      0
    );
    
    existingTest.updatedAt = new Date();
    
    // Save back to entity
    pedagogyRoot.You_Do.set(itemKey, existingTest);
    entity.markModified(`${pedagogyPath}.You_Do`);
    entity.updatedAt = new Date();
    if (req.user?.email) {
      entity.updatedBy = req.user.email;
    }
    
    await entity.save();
    
    // Prepare response
    const responseData = {
      itemKey: itemKey,
      totalQuestions: existingTest.questions.length,
      totalPoints: existingTest.totalPoints,
      addedQuestions: addedQuestions,
      settings: {
        timeLimit: existingTest.timeLimit,
        passingScore: existingTest.passingScore,
        attemptLimit: existingTest.attemptLimit,
        shuffleQuestions: existingTest.shuffleQuestions,
        showResults: existingTest.showResults,
        pointsPerQuestion: existingTest.pointsPerQuestion
      }
    };
    
    console.log(`✅ SUCCESS: Added ${addedQuestions.length} questions to ${itemKey}`);
    
    res.status(201).json({
      message: [{
        key: "success",
        value: `Added ${addedQuestions.length} question(s) to ${itemKey} successfully`
      }],
      data: responseData
    });
    
  } catch (err) {
    console.error("\n❌ FATAL ERROR in addMcqToYouDo ❌❌❌");
    console.error("Error message:", err.message);
    console.error("Error stack:", err.stack);
    
    res.status(500).json({
      message: [{
        key: "error",
        value: `Internal server error: ${err.message}`
      }]
    });
  }
};

// Get all You_Do items
exports.getYouDoItems = async (req, res) => {
 try {
    const { type, id } = req.params;
    
    if (!type || !modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}` }]
      });
    }
    
    const { model } = modelMap[type];
    const entity = await model.findById(id);
    
    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} with ID ${id} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Test Your Skills is a You Do feature, so it obeys the same rule as the
    // rest of You Do: a shared course keeps its material on the course-level
    // `pedagogy`, a batch-wise one on this batch's `batchPedagogy.<batchId>`.
    // This also removes a latent crash — the code below read
    // `entity.pedagogy.You_Do` with no guard on `entity.pedagogy` itself, and
    // a node that has never had anything uploaded has no `pedagogy` subdoc at
    // all. resolvePedagogyScope always returns a container.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, "You_Do", req);

    
    const allQuestions = [];
    
    if (pedagogyRoot.You_Do) {
      for (const [testItemKey, testData] of pedagogyRoot.You_Do.entries()) {
        const test = testData;
        
        if (test.questions && Array.isArray(test.questions)) {
          for (const question of test.questions) {
            allQuestions.push({
              _id: question._id,
              questionId: question._id,
              testItemKey: testItemKey,
              questionType: question.questionType,
              mcqQuestionTitle: question.mcqQuestionTitle,
              mcqQuestionDescription: question.mcqQuestionDescription,
              mcqQuestionType: question.mcqQuestionType,
              mcqQuestionDifficulty: question.mcqQuestionDifficulty,
              mcqQuestionScore: question.mcqQuestionScore,
              mcqQuestionOptions: question.mcqQuestionOptions,
              mcqQuestionCorrectAnswers: question.mcqQuestionCorrectAnswers,
              mcqQuestionOptionsPerRow: question.mcqQuestionOptionsPerRow,
              mcqQuestionRequired: question.mcqQuestionRequired,
              hasOtherOption: question.hasOtherOption,
              hasExplanation: question.hasExplanation,
              explanation: question.explanation,
              isActive: question.isActive,
              sequence: question.sequence,
              trueFalseAnswer: question.trueFalseAnswer,
              shortAnswer: question.shortAnswer,
              essayAnswer: question.essayAnswer,
              numericAnswer: question.numericAnswer,
              numericTolerance: question.numericTolerance,
              matchingPairs: question.matchingPairs,
              orderingItems: question.orderingItems,
              createdAt: question.createdAt,
              updatedAt: question.updatedAt,
              // Include parent test settings for context
              testSettings: {
                timeLimit: test.timeLimit,
                passingScore: test.passingScore,
                attemptLimit: test.attemptLimit,
                shuffleQuestions: test.shuffleQuestions,
                showResults: test.showResults,
                pointsPerQuestion: test.pointsPerQuestion,
                totalPoints: test.totalPoints
              }
            });
          }
        }
      }
    }
    
    // Sort by creation date (newest first)
    const sorted = allQuestions.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    
    res.status(200).json({
      success: true,
      totalQuestions: sorted.length,
      data: sorted
    });
    
  } catch (err) {
    console.error("Error getting all questions:", err);
    res.status(500).json({
      message: [{ key: "error", value: err.message }]
    });
  }
};
// Get specific You_Do item with all questions
exports.getYouDoItem = async (req, res) => {
  try {
    const { type, id, itemKey } = req.params;
    
    if (!type || !modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}` }]
      });
    }
    
    const { model } = modelMap[type];
    const entity = await model.findById(id);
    
    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} with ID ${id} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Test Your Skills is a You Do feature, so it obeys the same rule as the
    // rest of You Do: a shared course keeps its material on the course-level
    // `pedagogy`, a batch-wise one on this batch's `batchPedagogy.<batchId>`.
    // This also removes a latent crash — the code below read
    // `entity.pedagogy.You_Do` with no guard on `entity.pedagogy` itself, and
    // a node that has never had anything uploaded has no `pedagogy` subdoc at
    // all. resolvePedagogyScope always returns a container.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, "You_Do", req);

    
    if (!pedagogyRoot.You_Do || !pedagogyRoot.You_Do.has(itemKey)) {
      return res.status(404).json({
        message: [{ key: "error", value: `You_Do item "${itemKey}" not found` }]
      });
    }
    
    const youDoItem = pedagogyRoot.You_Do.get(itemKey);
    
    res.status(200).json({
      success: true,
      data: youDoItem
    });
    
  } catch (err) {
    console.error("Error getting You_Do item:", err);
    res.status(500).json({
      message: [{ key: "error", value: err.message }]
    });
  }
};



// Delete You_Do item
exports.deleteYouDoItem = async (req, res) => {
  try {
    const { type, id, itemKey } = req.params;
    
    if (!type || !modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}` }]
      });
    }
    
    const { model } = modelMap[type];
    const entity = await model.findById(id);
    
    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} with ID ${id} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Test Your Skills is a You Do feature, so it obeys the same rule as the
    // rest of You Do: a shared course keeps its material on the course-level
    // `pedagogy`, a batch-wise one on this batch's `batchPedagogy.<batchId>`.
    // This also removes a latent crash — the code below read
    // `entity.pedagogy.You_Do` with no guard on `entity.pedagogy` itself, and
    // a node that has never had anything uploaded has no `pedagogy` subdoc at
    // all. resolvePedagogyScope always returns a container.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, "You_Do", req);

    
    if (!pedagogyRoot.You_Do || !pedagogyRoot.You_Do.has(itemKey)) {
      return res.status(404).json({
        message: [{ key: "error", value: `You_Do item "${itemKey}" not found` }]
      });
    }
    
    pedagogyRoot.You_Do.delete(itemKey);
    entity.markModified(`${pedagogyPath}.You_Do`);
    await entity.save();
    
    res.status(200).json({
      success: true,
      message: `You_Do item "${itemKey}" deleted successfully`
    });
    
  } catch (err) {
    console.error("Error deleting You_Do item:", err);
    res.status(500).json({
      message: [{ key: "error", value: err.message }]
    });
  }
};

exports.deleteQuestionFromYouDo = async (req, res) => {
  try {
    const { type, id, itemKey, questionId } = req.params;
    
    if (!type || !modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}` }]
      });
    }
    
    const { model } = modelMap[type];
    const entity = await model.findById(id);
    
    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} with ID ${id} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Test Your Skills is a You Do feature, so it obeys the same rule as the
    // rest of You Do: a shared course keeps its material on the course-level
    // `pedagogy`, a batch-wise one on this batch's `batchPedagogy.<batchId>`.
    // This also removes a latent crash — the code below read
    // `entity.pedagogy.You_Do` with no guard on `entity.pedagogy` itself, and
    // a node that has never had anything uploaded has no `pedagogy` subdoc at
    // all. resolvePedagogyScope always returns a container.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, "You_Do", req);

    
    if (!pedagogyRoot.You_Do || !pedagogyRoot.You_Do.has(itemKey)) {
      return res.status(404).json({
        message: [{ key: "error", value: `You_Do item "${itemKey}" not found` }]
      });
    }
    
    const youDoItem = pedagogyRoot.You_Do.get(itemKey);
    
    // Find the question index
    const questionIndex = youDoItem.questions.findIndex(
      q => q._id.toString() === questionId
    );
    
    if (questionIndex === -1) {
      return res.status(404).json({
        message: [{ key: "error", value: "Question not found" }]
      });
    }
    
    // Remove question
    youDoItem.questions.splice(questionIndex, 1);
    
    // Re-sequence remaining questions
    youDoItem.questions.forEach((q, idx) => {
      q.sequence = idx;
    });
    
    // Recalculate total points
    youDoItem.totalPoints = youDoItem.questions.reduce(
      (sum, q) => sum + (q.mcqQuestionScore || youDoItem.pointsPerQuestion || 1),
      0
    );
    
    youDoItem.updatedAt = new Date();
    
    pedagogyRoot.You_Do.set(itemKey, youDoItem);
    entity.markModified(`${pedagogyPath}.You_Do`);
    await entity.save();
    
    res.status(200).json({
      success: true,
      message: "Question deleted successfully",
      remainingQuestions: youDoItem.questions.length,
      totalPoints: youDoItem.totalPoints
    });
    
  } catch (err) {
    console.error("Error deleting question:", err);
    res.status(500).json({
      message: [{ key: "error", value: err.message }]
    });
  }
};


// Add this to your testYourSkillsController.js

exports.updateQuestionInYouDo = async (req, res) => {
  try {
    const { type, id, itemKey, questionId } = req.params;
    const updateData = req.body;
    
    if (!type || !modelMap[type]) {
      return res.status(400).json({
        message: [{ key: "error", value: `Invalid entity type: ${type}` }]
      });
    }
    
    const { model } = modelMap[type];
    const entity = await model.findById(id);
    
    if (!entity) {
      return res.status(404).json({
        message: [{ key: "error", value: `${type} with ID ${id} not found` }]
      });
    }
    // ── Resources by Batch ───────────────────────────────────────────────
    // Test Your Skills is a You Do feature, so it obeys the same rule as the
    // rest of You Do: a shared course keeps its material on the course-level
    // `pedagogy`, a batch-wise one on this batch's `batchPedagogy.<batchId>`.
    // This also removes a latent crash — the code below read
    // `entity.pedagogy.You_Do` with no guard on `entity.pedagogy` itself, and
    // a node that has never had anything uploaded has no `pedagogy` subdoc at
    // all. resolvePedagogyScope always returns a container.
    const { container: pedagogyRoot, basePath: pedagogyPath } =
      await resolvePedagogyScope(entity, "You_Do", req);

    
    if (!pedagogyRoot.You_Do || !pedagogyRoot.You_Do.has(itemKey)) {
      return res.status(404).json({
        message: [{ key: "error", value: `You_Do item "${itemKey}" not found` }]
      });
    }
    
    const youDoItem = pedagogyRoot.You_Do.get(itemKey);
    
    // Find the question index
    const questionIndex = youDoItem.questions.findIndex(
      q => q._id.toString() === questionId
    );
    
    if (questionIndex === -1) {
      return res.status(404).json({
        message: [{ key: "error", value: "Question not found" }]
      });
    }
    
    const existingQuestion = youDoItem.questions[questionIndex];
    
    // Process mcqQuestionTitle if it's content blocks
    let processedTitle = updateData.mcqQuestionTitle;
    let extractedText = '';
    
    if (Array.isArray(updateData.mcqQuestionTitle)) {
      processedTitle = await processMixedContent(
        updateData.mcqQuestionTitle,
        entity._id.toString(),
        itemKey,
        questionId
      );
      
      extractedText = updateData.mcqQuestionTitle
        .filter(block => block.type === 'text')
        .map(block => (block.value || '').replace(/<[^>]*>/g, '').trim())
        .join(' ')
        .substring(0, 500);
    } else if (typeof updateData.mcqQuestionTitle === 'string') {
      extractedText = updateData.mcqQuestionTitle;
    }
    
    // Process options if they exist
    let processedOptions = [];
    if (updateData.mcqQuestionOptions && Array.isArray(updateData.mcqQuestionOptions)) {
      processedOptions = await processOptionImages(
        updateData.mcqQuestionOptions,
        entity._id.toString(),
        itemKey,
        questionId
      );
    }
    
    // Type mapping from frontend to backend
    const typeMapping = {
      'multiple-choice': 'multiple_choice',
      'multiple-select': 'multiple_select',
      'true-false': 'true_false',
      'short-answer': 'short_answer',
      'paragraph': 'essay',
      'matching': 'matching',
      'ordering': 'ordering',
      'numeric': 'numeric',
      'dropdown': 'dropdown'
    };
    
    // Update the question
    const updatedQuestion = {
      ...existingQuestion,
      mcqQuestionTitle: processedTitle,
      mcqQuestionDescription: updateData.mcqQuestionDescription || existingQuestion.mcqQuestionDescription,
      mcqQuestionType: typeMapping[updateData.mcqQuestionType] || existingQuestion.mcqQuestionType,
      mcqQuestionDifficulty: updateData.mcqQuestionDifficulty || existingQuestion.mcqQuestionDifficulty,
      mcqQuestionScore: updateData.mcqQuestionScore || existingQuestion.mcqQuestionScore,
      mcqQuestionOptions: processedOptions.length > 0 ? processedOptions : existingQuestion.mcqQuestionOptions,
      mcqQuestionCorrectAnswers: updateData.mcqQuestionCorrectAnswers || existingQuestion.mcqQuestionCorrectAnswers,
      mcqQuestionOptionsPerRow: updateData.mcqQuestionOptionsPerRow || existingQuestion.mcqQuestionOptionsPerRow,
      mcqQuestionRequired: updateData.mcqQuestionRequired !== undefined ? updateData.mcqQuestionRequired : existingQuestion.mcqQuestionRequired,
      hasOtherOption: updateData.hasOtherOption !== undefined ? updateData.hasOtherOption : existingQuestion.hasOtherOption,
      hasExplanation: updateData.hasExplanation !== undefined ? updateData.hasExplanation : existingQuestion.hasExplanation,
      explanation: updateData.explanation || existingQuestion.explanation,
      isActive: updateData.isActive !== undefined ? updateData.isActive : existingQuestion.isActive,
      trueFalseAnswer: updateData.trueFalseAnswer !== undefined ? updateData.trueFalseAnswer : existingQuestion.trueFalseAnswer,
      shortAnswer: updateData.shortAnswer || existingQuestion.shortAnswer,
      essayAnswer: updateData.essayAnswer || existingQuestion.essayAnswer,
      numericAnswer: updateData.numericAnswer !== undefined ? updateData.numericAnswer : existingQuestion.numericAnswer,
      numericTolerance: updateData.numericTolerance !== undefined ? updateData.numericTolerance : existingQuestion.numericTolerance,
      matchingPairs: updateData.matchingPairs || existingQuestion.matchingPairs,
      orderingItems: updateData.orderingItems || existingQuestion.orderingItems,
      updatedAt: new Date()
    };
    
    // Add search text if needed
    if (extractedText) {
      updatedQuestion._searchText = extractedText;
    }
    
    youDoItem.questions[questionIndex] = updatedQuestion;
    
    // Recalculate total points
    youDoItem.totalPoints = youDoItem.questions.reduce(
      (sum, q) => sum + (q.mcqQuestionScore || youDoItem.pointsPerQuestion || 1),
      0
    );
    
    youDoItem.updatedAt = new Date();
    
    pedagogyRoot.You_Do.set(itemKey, youDoItem);
    entity.markModified(`${pedagogyPath}.You_Do`);
    await entity.save();
    
    res.status(200).json({
      success: true,
      message: "Question updated successfully",
      data: updatedQuestion
    });
    
  } catch (err) {
    console.error("Error updating question:", err);
    res.status(500).json({
      message: [{ key: "error", value: err.message }]
    });
  }
};