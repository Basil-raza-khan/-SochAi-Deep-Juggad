require('dotenv').config();
const Fastify = require('fastify');
const fastifyIO = require('fastify-socket.io');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('@fastify/cors');

const fastify = Fastify({ 
  logger: true,
  trustProxy: true
});

// Configure socket.io with proper CORS and WebSocket settings
fastify.register(fastifyIO, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket'],
  pingTimeout: 30000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  allowUpgrades: true,
  cookie: false
});

// Configure CORS for REST endpoints
fastify.register(cors, { 
  origin: "*",
  methods: ["GET", "POST"],
  credentials: true
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// Store chat histories (in-memory storage - replace with database in production)
const chatHistories = new Map();

function formatResponse(text) {
  // Add emojis based on content
  const emojiMap = {
    'recipe': '👩‍🍳',
    'ingredients': '🥘',
    'instructions': '📝',
    'tip': '💡',
    'note': '📌',
    'warning': '⚠️',
    'important': '❗',
    'success': '✅',
    'steps': '📋',
    'time': '⏰',
    'temperature': '🌡️',
    'serving': '🍽️',
  };

  // Add formatting
  let formattedText = text;
  
  // Format headers
  formattedText = formattedText.replace(/^(#+)\s*(.*)/gm, (_, hashes, content) => {
    const emoji = Object.entries(emojiMap).find(([key]) => 
      content.toLowerCase().includes(key)
    )?.[1] || '';
    return `\n${emoji} ${content.toUpperCase()} ${emoji}\n`;
  });

  // Format lists
  formattedText = formattedText.replace(/^\*\s+(.+)/gm, '• $1');
  
  // Format sections
  formattedText = formattedText.replace(/^(For|Step \d+|Instructions|Ingredients|Note|Tip):/gm, 
    (match) => `\n${emojiMap[match.toLowerCase().split(':')[0]] || ''}  ${match}`);

  // Add spacing
  formattedText = formattedText.replace(/\n\n+/g, '\n\n');

  return formattedText;
}

async function chatBot(socket, prompt, chatId) {
    try {
        // Initialize chat history if it doesn't exist
        if (!chatHistories.has(chatId)) {
            chatHistories.set(chatId, []);
        }

        // Add user message to history
        chatHistories.get(chatId).push({ role: 'user', text: prompt });

        // Generate response
        const result = await model.generateContentStream([
            { text: "You are a helpful AI assistant. Format your responses in a clear, organized way with appropriate emojis and sections. Keep responses concise but informative." },
            ...chatHistories.get(chatId).map(msg => ({ text: msg.text })),
        ]);

        let completeResponse = '';
        for await (const chunk of result.stream) {
            completeResponse += chunk.text();
        }

        // Format and send the complete response
        const formattedResponse = formatResponse(completeResponse);
        if (socket.connected) {
            socket.emit("response", formattedResponse);
            socket.emit("response", "Finished");
        }

        // Add AI response to history
        chatHistories.get(chatId).push({ role: 'assistant', text: completeResponse });

    } catch (error) {
        console.error("Error in chatBot:", error);
        if (socket.connected) {
            socket.emit("response", "❌ Sorry, there was an error processing your request.");
            socket.emit("response", "Finished");
        }
    }
}

fastify.ready(err => {
    if (err) {
        console.error("Fastify failed to start:", err);
        throw err;
    }

    console.log("Fastify server is running");

    fastify.io.on("connection", (socket) => {
        console.log("Client connected:", socket.id);
        
        // Create a new chat ID for this session
        const chatId = socket.id;

        socket.on("user-query", async (message) => {
            console.log("User Query from", socket.id, ":", message);
            await chatBot(socket, message, chatId);
        });

        socket.on("new-chat", () => {
            // Clear chat history for this user
            chatHistories.delete(chatId);
        });

        socket.on("disconnect", (reason) => {
            console.log("Client disconnected:", socket.id, "Reason:", reason);
            // Optionally, clean up chat history after some time
            setTimeout(() => chatHistories.delete(chatId), 3600000); // Clean up after 1 hour
        });

        socket.on("error", (error) => {
            console.error("Socket error for", socket.id, ":", error);
        });
    });
});

// Listen on all network interfaces
fastify.listen({ 
    port: 3000, 
    host: '0.0.0.0'
}, (err) => {
    if (err) {
        console.error("Error starting server:", err);
        process.exit(1);
    }
    console.log("Server running on port 3000");
});
