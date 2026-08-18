
    // simple-test.js
const fetch = require('node-fetch');

async function testOneRequest() {
    console.log("🔍 Testing Gemini API with ONE request...\n");
    
    const API_KEY = process.env.GEMINI_API_KEY;
    const prompt = "Hello! What is 2+2? Answer in one word.";
    
    console.log(`📤 Prompt: "${prompt}"`);
    console.log(`🔑 Using API key: ${API_KEY.substring(0, 10)}...`);
    
    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    contents: [{ 
                        parts: [{ 
                            text: prompt 
                        }] 
                    }]
                })
            }
        );
        
        console.log(`\n📥 Response Status: ${response.status} ${response.statusText}`);
        
        if (response.status === 429) {
            console.log("❌ 429 Too Many Requests - You're being rate limited!");
            console.log("💡 Wait a few minutes and try again.");
            return;
        }
        
        if (!response.ok) {
            const errorText = await response.text();
            console.log("❌ Error Response:", errorText.substring(0, 200));
            return;
        }
        
        const data = await response.json();
        console.log("✅ API Response received!");
        
        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
            const answer = data.candidates[0].content.parts[0].text;
            console.log(`\n🤖 AI Answer: "${answer}"`);
        } else {
            console.log("⚠️ Unexpected response format:", JSON.stringify(data, null, 2));
        }
        
    } catch (error) {
        console.log("❌ Request failed:", error.message);
        console.log("💡 Check your internet connection and API key.");
    }
}

// Run the test
testOneRequest();