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

// Create EC2 connection
const connectToEC2 = () => {
  return new Promise((resolve, reject) => {
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
        privateKey: fs.readFileSync(path.resolve(__dirname, process.env.EC2_KEY_PATH))
      });
  });
};

// Start MediaMTX
app.post('/start-mt', async (req, res) => {
  console.log("🔄 Connecting to EC2...");
  
  try {
    const conn = await connectToEC2();
    console.log("✅ SSH CONNECTION ESTABLISHED with EC2");

    conn.exec(process.env.HLS_COMMAND, (err, stream) => {
      if (err) {
        conn.end();
        return res.status(500).json({ error: err.message });
      }

      console.log("🚀 MediaMTX starting in background...");

      stream.on('close', () => {
        conn.end();
        console.log("📤 Responding with stream URLs...");
        
        res.json({
          message: "MediaMTX started successfully",
          streams: [
            "http://3.16.91.248:8888/stream1/index.m3u8",
            "http://3.16.91.248:8888/stream2/index.m3u8", 
            "http://3.16.91.248:8888/stream3/index.m3u8"
          ]
        });
      });
    });
  } catch (err) {
    console.log("❌ ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Default route
app.get('/', (req, res) => {
  res.json({ message: "Express API is running!" });
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});