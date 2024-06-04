const chatBox = document.getElementById("chat-box");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const recordBtn = document.getElementById("record-btn");
const inputContainer = document.getElementById("input-container");
let microphone;  // Declare microphone variable here to keep it in scope
let socket;      // Declare socket variable here to keep it in scope
let silenceDetected = false;
let silenceTimeout;

async function fetchOpenAIResponseStream(prompt) {
  const response = await fetch("/openai/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt }),
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = "";

  // Create a new message element for the streaming response
  const message = document.createElement("div");
  message.classList.add("message", "ai-message");
  chatBox.appendChild(message);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    content += decoder.decode(value);
    message.innerText += decoder.decode(value);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  // Convert the final response to speech using ElevenLabs
  await speakText(content);

  // Remove the streaming class once the message is complete
  message.classList.remove("streaming-message");
}

function appendMessage(content, isUser = true) {
  const message = document.createElement("div");
  message.classList.add("message", isUser ? "user-message" : "ai-message");
  message.innerText = content;
  chatBox.appendChild(message);
  chatBox.scrollTop = chatBox.scrollHeight;
}

async function speakText(text) {
  try {
    const response = await fetch("/elevenlabs-tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        voice_id: "1qEiC6qsybMkmnNdVMbK", // Replace with the desired voice ID
        voice_settings: {
          stability: 1,
          similarity_boost: 1,
          style: 1,
          use_speaker_boost: true
        }
      })
    });

    if (!response.ok) {
      throw new Error("Failed to generate speech");
    }

    const audioBlob = await response.blob();
    console.log("Audio Blob size:", audioBlob.size); // Log the size of the audio blob

    // Ensure the blob is valid and play it
    if (audioBlob.size > 0) {
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audio.controls = true;  // Add controls for manual testing
      document.body.appendChild(audio);  // Add to DOM for manual control

      audio.addEventListener('canplaythrough', () => {
        console.log("Audio can play through");
        audio.volume = 1.0;  // Ensure volume is set to max
        audio.play().catch(e => console.error("Error playing audio:", e));
      }, { once: true });

      audio.addEventListener('ended', () => {
        console.log("Audio playback ended");
        document.body.removeChild(audio);  // Clean up after playback
      });

      audio.addEventListener('error', (e) => {
        console.error("Audio playback error", e);
      });

      audio.addEventListener('loadeddata', () => {
        console.log("Audio loaded");
      });

      audio.load();  // Explicitly load the audio to ensure it's ready for playback
    } else {
      console.error("Received empty audio blob");
    }
  } catch (error) {
    console.error("Error with ElevenLabs TTS:", error);
  }
}

sendBtn.addEventListener("click", async () => {
  const prompt = userInput.value;
  if (prompt.trim() === "") {
    alert("Please enter a message.");
    return;
  }

  appendMessage(prompt);
  userInput.value = "";

  await fetchOpenAIResponseStream(prompt);
});

recordBtn.addEventListener("click", async () => {
  if (!microphone) {
    const key = await getTempApiKey();
    const { createClient } = deepgram;
    const _deepgram = createClient(key);

    socket = _deepgram.listen.live({
      model: "nova-2-general",
      language: "hi",
      smart_format: true,
    });

    socket.on("open", async () => {
      console.log("client: connected to websocket");

      microphone = await getMicrophone();
      await openMicrophone(microphone, socket);

      // Move mic to center and add waves
      recordBtn.classList.add("active");
      inputContainer.classList.add("mic-active");
    });

    socket.on("Results", async (data) => {
      console.log(data);
      const transcript = data.channel.alternatives[0].transcript;

      if (transcript !== "") {
        appendMessage(transcript);
        silenceDetected = false;
        clearTimeout(silenceTimeout);
        silenceTimeout = setTimeout(async () => {
          silenceDetected = true;
          await fetchOpenAIResponseStream(transcript);
        }, 1200); // Silence detection timeout set to 1.2 seconds
      }
    });

    socket.on("error", (e) => console.error(e));
    socket.on("warning", (e) => console.warn(e));
    socket.on("Metadata", (e) => console.log(e));
    socket.on("close", (e) => console.log(e));
  } else {
    // If microphone is already running, stop it
    await closeMicrophone(microphone);
    microphone = undefined;

    // Move mic back to original position and remove waves
    recordBtn.classList.remove("active");
    inputContainer.classList.remove("mic-active");
  }
});

async function getTempApiKey() {
  const result = await fetch("/key");
  const json = await result.json();
  return json.key;
}

async function getMicrophone() {
  const userMedia = await navigator.mediaDevices.getUserMedia({
    audio: true,
  });
  return new MediaRecorder(userMedia);
}

async function openMicrophone(microphone, socket) {
  microphone.start(500);

  microphone.onstart = () => {
    console.log("client: microphone opened");
    document.body.classList.add("recording");
  };

  microphone.onstop = () => {
    console.log("client: microphone closed");
    document.body.classList.remove("recording");
  };

  microphone.ondataavailable = (e) => {
    const data = e.data;
    console.log("client: sent data to websocket");
    socket.send(data);
  };
}

async function closeMicrophone(microphone) {
  microphone.stop();
}

// Fetch the ElevenLabs API key when the page loads
fetchElevenLabsApiKey();
