require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

/* ------------------------------------------------------------------
   WRITE EC2 PRIVATE KEY FROM ENV VARIABLE (Render-compatible)
------------------------------------------------------------------ */
const keyPath = path.resolve(__dirname, process.env.EC2_KEY_PATH || 'mediamtx-key.pem');

// Only write the key file if it doesn't already exist
if (!fs.existsSync(keyPath)) {
  console.log("🔐 Writing EC2 private key from environment variable...");

  if (!process.env.EC2_KEY) {
    console.log("❌ EC2_KEY environment variable is missing");
  } else {
    fs.writeFileSync(keyPath, process.env.EC2_KEY, {
      mode: 0o600, // Secure file permissions
    });
    console.log("✅ EC2 private key written to:", keyPath);
  }
}

/* ------------------------------------------------------------------
   SSH CONNECTION TO EC2
------------------------------------------------------------------ */
const connectToEC2 = () => {
  return new Promise((resolve, reject) => {
    // Validate required environment variables
    if (!process.env.EC2_HOST) {
      reject(new Error("Missing required environment variable: EC2_HOST"));
      return;
    }
    if (!process.env.EC2_USER) {
      reject(new Error("Missing required environment variable: EC2_USER"));
      return;
    }
    if (!fs.existsSync(keyPath)) {
      reject(new Error(`EC2 private key file not found at: ${keyPath}`));
      return;
    }

    const conn = new Client();
    console.log("🔄 Connecting to EC2...");

    conn
      .on('ready', () => {
        console.log("✅ SSH CONNECTION ESTABLISHED with EC2");
        resolve(conn);
      })
      .on('error', (err) => {
        console.log("❌ SSH CONNECTION FAILED:", err.message);
        reject(err);
      })
      .connect({
        host: process.env.EC2_HOST,
        username: process.env.EC2_USER,
        privateKey: fs.readFileSync(keyPath)
      });
  });
};

/* ------------------------------------------------------------------
   START MEDIAMTX ON EC2 (DETACHED, PERSISTENT)
------------------------------------------------------------------ */
app.post('/start-mt', async (req, res) => {
  try {
    const conn = await connectToEC2();

    // Use the HLS_COMMAND from environment or fallback to default
    const startCommand = process.env.HLS_COMMAND || `
      nohup setsid /usr/local/bin/mediamtx /home/ec2-user/mediamtx.yml > /home/ec2-user/mediamtx.log 2>&1 < /dev/null &
    `;

    console.log("🚀 Starting MediaMTX on EC2...");
    console.log("📝 Command:", startCommand);

    conn.exec(startCommand, (err, stream) => {
      if (err) {
        conn.end();
        return res.status(500).json({ error: err.message });
      }

      let output = '';

      stream
        .on('data', (data) => {
          output += data.toString();
          console.log('SSH Output:', data.toString());
        })
        .stderr.on('data', (data) => {
          console.log('SSH Error:', data.toString());
        })
        .on('close', (code, signal) => {
          conn.end();
          console.log("✅ MediaMTX startup command completed");

          res.json({
            message: "MediaMTX started successfully",
            streams: [
              "http://3.16.91.248:8888/stream1/index.m3u8",
              "http://3.16.91.248:8888/stream2/index.m3u8",
              "http://3.16.91.248:8888/stream3/index.m3u8",
              "http://3.16.91.248:8888/stream4/index.m3u8",
              "http://3.16.91.248:8888/stream5/index.m3u8"
            ]
          });
        });
    });
  } catch (err) {
    console.log("❌ ERROR:", err.message);
    res.status(500).json({ 
      error: err.message,
      details: "Check if EC2_HOST, EC2_USER, and EC2_KEY environment variables are properly set"
    });
  }
});

/* ------------------------------------------------------------------
   HEALTH CHECK ENDPOINT
------------------------------------------------------------------ */
app.get('/health', (req, res) => {
  const envVars = {
    EC2_HOST: process.env.EC2_HOST ? 'Set' : 'Missing',
    EC2_USER: process.env.EC2_USER ? 'Set' : 'Missing', 
    EC2_KEY: process.env.EC2_KEY ? 'Set' : 'Missing',
    EC2_KEY_PATH: process.env.EC2_KEY_PATH ? 'Set' : 'Missing',
    HLS_COMMAND: process.env.HLS_COMMAND ? 'Set' : 'Using default',
    PORT: process.env.PORT || 5000,
    keyFileExists: fs.existsSync(keyPath) ? 'Exists' : 'Missing',
    keyPath: keyPath
  };

  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: envVars
  });
});

/* ------------------------------------------------------------------
   DEFAULT ROUTE
------------------------------------------------------------------ */
app.get('/', (req, res) => {
  res.json({ 
    message: "Express API is running!",
    endpoints: {
      startMediaMTX: 'POST /start-mt',
      health: 'GET /health'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});