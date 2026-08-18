const express = require("express");
const router = express.Router();
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { createClient } = require('@deepgram/sdk');

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

// Initialize Deepgram with the new SDK
const deepgram = createClient('dd2748b4f66a83c57ec5b832f4cfaa8ae3c00ae0'); // Replace with your actual API key

// Utility function to download video file
async function downloadVideoFile(videoUrl) {
  try {
    
    const response = await axios({
      method: 'GET',
      url: videoUrl,
      responseType: 'arraybuffer',
      timeout: 300000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*'
      }
    });

    if (response.status !== 200) {
      throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);
    }

    const tempDir = path.join(__dirname, 'temp');
    await fs.ensureDir(tempDir);
    
    const videoPath = path.join(tempDir, `video_${Date.now()}.mp4`);
    await fs.writeFile(videoPath, response.data);
    
    return videoPath;
    
  } catch (error) {
    console.error("Video download error:", error);
    throw new Error(`Failed to download video: ${error.message}`);
  }
}

// Convert video to audio for Deepgram
async function convertVideoToAudio(videoPath) {
  return new Promise((resolve, reject) => {
    const audioFilename = `audio_${Date.now()}.wav`;
    const audioDir = path.join(__dirname, 'temp');
    const audioPath = path.join(audioDir, audioFilename);
    
    // Ensure audio directory exists
    fs.ensureDirSync(audioDir);
    
    
    ffmpeg(videoPath)
      .toFormat('wav')
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec('pcm_s16le')
      .on('start', (commandLine) => {
      })
      .on('progress', (progress) => {
      })
      .on('end', () => {
        resolve({
          audioPath: audioPath,
          audioFilename: audioFilename
        });
      })
      .on('error', (err) => {
        console.error('Audio conversion error:', err);
        reject(new Error(`Audio conversion failed: ${err.message}`));
      })
      .save(audioPath);
  });
}

// Transcribe audio using Deepgram (Updated for new SDK)
async function transcribeWithDeepgram(audioPath) {
  try {
    
    const audioBuffer = await fs.readFile(audioPath);
    
    // Use the new SDK syntax
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      audioBuffer,
      {
        mimetype: 'audio/wav',
        smart_format: true,
        model: 'nova-2',
        punctuate: true,
        paragraphs: true,
        utterances: true,
        diarize: true,
        language: 'en'
      }
    );

    if (error) {
      throw new Error(`Deepgram API error: ${error.message}`);
    }

    
    if (!result) {
      throw new Error('No transcription results from Deepgram');
    }

    return result;
  } catch (error) {
    console.error("Deepgram transcription error:", error);
    throw new Error(`Deepgram transcription failed: ${error.message}`);
  }
}

// Get video duration
async function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        console.error("Error getting video duration:", err);
        resolve(0);
      } else {
        resolve(Math.round(metadata.format.duration));
      }
    });
  });
}

// Format Deepgram results
function formatDeepgramResults(deepgramResult, title, duration) {
  const result = deepgramResult.results;
  
  if (!result || !result.channels || !result.channels[0]) {
    throw new Error('Invalid Deepgram response format');
  }

  const channel = result.channels[0];
  const transcript = channel.alternatives[0].transcript || '';
  const words = channel.alternatives[0].words || [];
  const paragraphs = channel.alternatives[0].paragraphs || null;
  
  // Create segments from words
  const segments = words.map(word => ({
    start: word.start,
    end: word.end,
    text: word.punctuated_word || word.word
  }));

  // Calculate word count
  const wordCount = transcript.split(/\s+/).filter(word => word.length > 0).length;

  // Create comprehensive transcript with timestamps
  let formattedTranscript = `VIDEO TRANSCRIPTION: ${title}\n\n`;
  formattedTranscript += `Duration: ${duration} seconds (${Math.round(duration/60)} minutes)\n`;
  formattedTranscript += `Word Count: ${wordCount}\n\n`;
  formattedTranscript += `FULL TRANSCRIPT:\n${transcript}\n\n`;

  if (paragraphs && paragraphs.paragraphs) {
    formattedTranscript += `STRUCTURED PARAGRAPHS:\n`;
    paragraphs.paragraphs.forEach((paragraph, index) => {
      formattedTranscript += `\nParagraph ${index + 1} (${paragraph.sentences.length} sentences):\n`;
      formattedTranscript += `${paragraph.paragraph}\n`;
    });
  }

  if (segments.length > 0) {
    formattedTranscript += `\nDETAILED TIMELINE:\n`;
    segments.forEach((segment, index) => {
      if (index % 20 === 0) { // Show every 20th word for brevity
        const timestamp = formatTimestamp(segment.start);
        formattedTranscript += `[${timestamp}] ${segment.text}\n`;
      }
    });
  }

  return {
    transcript: formattedTranscript,
    rawTranscript: transcript,
    totalSegments: segments.length,
    segments: segments,
    wordCount: wordCount,
    confidence: channel.alternatives[0].confidence || 0,
    paragraphs: paragraphs ? paragraphs.paragraphs : []
  };
}

// Helper function to format timestamp
function formatTimestamp(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Clean up temporary files
async function cleanupFiles(filePaths) {
  try {
    for (const filePath of filePaths) {
      if (await fs.pathExists(filePath)) {
        await fs.remove(filePath);
      }
    }
  } catch (error) {
    console.warn("Cleanup warning:", error.message);
  }
}

// Main transcription endpoint
router.post("/extract-audio", async (req, res) => {
  
  let videoPath;
  let audioPath;
  const tempFiles = [];

  try {
    const { videoUrl, title } = req.body;
 

    if (!videoUrl) {
      return res.status(400).json({
        success: false,
        error: "Video URL is required"
      });
    }

    // Step 1: Download video file
    videoPath = await downloadVideoFile(videoUrl);
    tempFiles.push(videoPath);

    // Step 2: Convert video to audio
    const audioResult = await convertVideoToAudio(videoPath);
    audioPath = audioResult.audioPath;
    tempFiles.push(audioPath);

    // Step 3: Get video duration
    const videoDuration = await getVideoDuration(videoPath);

    // Step 4: Transcribe with Deepgram
    const deepgramResult = await transcribeWithDeepgram(audioPath);

    // Step 5: Format results
    const transcription = formatDeepgramResults(deepgramResult, title, videoDuration);


    // Prepare response
    const response = {
      success: true,
      transcription: {
        transcript: transcription.transcript,
        rawTranscript: transcription.rawTranscript,
        totalSegments: transcription.totalSegments,
        segments: transcription.segments,
        wordCount: transcription.wordCount,
        confidence: transcription.confidence,
        paragraphs: transcription.paragraphs
      },
      metadata: {
        duration: videoDuration,
        title: title,
        processedAt: new Date().toISOString(),
        audioSampleRate: 16000,
        audioChannels: 1,
        audioExtracted: true,
        transcriptionEngine: 'Deepgram Nova-2',
        confidence: transcription.confidence,
        language: 'en',
        wordCount: transcription.wordCount,
        message: "Video successfully transcribed using Deepgram AI."
      }
    };

    res.json(response);

  } catch (error) {
    console.error("Video transcription process error:", error);
    
    res.status(500).json({
      success: false,
      error: error.message,
      details: "Video transcription failed. Please ensure the video file is accessible and contains clear audio."
    });
    
  } finally {
    // Clean up temporary files
    if (tempFiles.length > 0) {
      setTimeout(() => cleanupFiles(tempFiles), 5000);
    }
  }
});

// Health check endpoint
router.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Video transcription service is running",
    features: {
      videoDownload: true,
      audioExtraction: true,
      speechToText: true,
      transcriptionEngine: "Deepgram",
      supportedFormats: ["mp4", "avi", "mov", "wmv", "mkv"]
    },
    timestamp: new Date().toISOString()
  });
});

module.exports = router;