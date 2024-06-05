const express = require("express");
const http = require("http");
const { createClient } = require("@deepgram/sdk");
const OpenAI = require("openai");
const dotenv = require("dotenv");
const fetch = require("node-fetch");
const WebSocket = require("ws"); // Add WebSocket library
dotenv.config();

const client = createClient(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server }); // WebSocket server

app.use(express.json());
app.use(express.static("public/"));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

app.get("/elevenlabs-api-key", (req, res) => {
  res.json({ apiKey: process.env.ELEVENLABS_API_KEY });
});

const getProjectId = async () => {
  const { result, error } = await client.manage.getProjects();

  if (error) {
    throw error;
  }

  return result.projects[0].project_id;
};

const getTempApiKey = async (projectId) => {
  const { result, error } = await client.manage.createProjectKey(projectId, {
    comment: "short lived",
    scopes: ["usage:write"],
    time_to_live_in_seconds: 20,
  });

  if (error) {
    throw error;
  }

  return result;
};

app.get("/key", async (req, res) => {
  try {
    const projectId = await getProjectId();
    const key = await getTempApiKey(projectId);
    res.json(key);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/openai", async (req, res) => {
  try {
    const { prompt } = req.body;
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
    });
    res.json(response.choices[0].message.content.trim());
  } catch (error) {
    console.error("Error communicating with OpenAI:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to handle streaming responses from OpenAI
app.post("/openai/stream", async (req, res) => {
  try {
    const { prompt } = req.body;
    const stream = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      stream: true,
    });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    for await (const chunk of stream) {
      res.write(chunk.choices[0]?.delta?.content || "");
    }

    res.end();
  } catch (error) {
    console.error("Error communicating with OpenAI:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/elevenlabs-tts", async (req, res) => {
  try {
    const { text, voice_id, voice_settings, pronunciation_dictionary_locators, seed, previous_text, next_text, previous_request_ids, next_request_ids } = req.body;

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": process.env.ELEVENLABS_API_KEY // Use the correct header for the API key
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to generate speech: ${errorText}`);
    }

    const audioBuffer = await response.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audioBuffer.byteLength);
    res.send(Buffer.from(audioBuffer));
  } catch (error) {
    console.error("Error with ElevenLabs TTS:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// WebSocket handling for prerecorded audio
wss.on('connection', async (ws) => {
  console.log('WebSocket connection established');

  // Send initial greeting message
  const greetingText = "Hello, How are you?";
  try {
    const ttsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/1qEiC6qsybMkmnNdVMbK`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": process.env.ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text: greetingText,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 1,
          similarity_boost: 1,
          style: 1,
          use_speaker_boost: true
        }
      })
    });

    if (!ttsResponse.ok) {
      throw new Error(`Failed to generate speech: ${await ttsResponse.text()}`);
    }
    if (ttsResponse.ok) {
      console.log("tts ok: "+ ttsResponse.arrayBuffer());
    }

    const greetingAudioBuffer = await ttsResponse.arrayBuffer();
    ws.send(Buffer.from(greetingAudioBuffer));
  } catch (error) {
    console.error("Error with ElevenLabs TTS:", error.message);
  }

  ws.on('message', async (message) => {
    console.log('Received message:', message);

    // Process the message with Deepgram and OpenAI
    try {
      const deepgramResponse = await client.transcription.preRecorded({
        buffer: message,
        mimetype: 'audio/mpeg'
      });

      const transcript = deepgramResponse.results.channels[0].alternatives[0].transcript;

      const openaiResponse = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: transcript }],
      });

      const aiResponse = openaiResponse.choices[0].message.content.trim();

      // Convert AI response to speech and send it back
      const ttsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/1qEiC6qsybMkmnNdVMbK`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": process.env.ELEVENLABS_API_KEY
        },
        body: JSON.stringify({
          text: aiResponse,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 1,
            similarity_boost: 1,
            style: 1,
            use_speaker_boost: true
          }
        })
      });

      if (!ttsResponse.ok) {
        throw new Error(`Failed to generate speech: ${await ttsResponse.text()}`);
      }

      const audioBuffer = await ttsResponse.arrayBuffer();
      ws.send(Buffer.from(audioBuffer));
    } catch (error) {
      console.error("Error processing message:", error.message);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// New WebSocket handling for live audio from Exotel
const liveWss = new WebSocket.Server({ server, path: "/live" }); 

liveWss.on('connection', (ws) => {
  console.log('Live WebSocket connection established');

  ws.on('message', async (message) => {
    console.log('Received live audio message:', message);

    // Process the live audio message with Deepgram and OpenAI
    try {
      const deepgramResponse = await client.transcription.live({
        buffer: message,
        mimetype: 'audio/mpeg'
      });

      const transcript = deepgramResponse.results.channels[0].alternatives[0].transcript;
      console.log('Transcription:', transcript);

      const openaiResponse = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: transcript }],
      });

      const aiResponse = openaiResponse.choices[0].message.content.trim();
      console.log('AI Response:', aiResponse);

      // Convert AI response to speech and send it back
      const ttsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/1qEiC6qsybMkmnNdVMbK`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": process.env.ELEVENLABS_API_KEY
        },
        body: JSON.stringify({
          text: aiResponse,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 1,
            similarity_boost: 1,
            style: 1,
            use_speaker_boost: true
          }
        })
      });

      if (!ttsResponse.ok) {
        throw new Error(`Failed to generate speech: ${await ttsResponse.text()}`);
      }

      const audioBuffer = await ttsResponse.arrayBuffer();
      ws.send(Buffer.from(audioBuffer));
    } catch (error) {
      console.error("Error processing live audio message:", error.message);
    }
  });

  ws.on('close', () => {
    console.log('Live WebSocket connection closed');
  });

  ws.on('error', (error) => {
    console.error('Live WebSocket error:', error);
  });
});

server.listen(3001, () => {
  console.log("listening on http://localhost:3000");
});
