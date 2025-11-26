require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

/* ------------------------------------------------------------------
   WRITE EC2 PRIVATE KEY FROM ENV VARIABLE (Render-compatible)
------------------------------------------------------------------ */
const keyPath = path.resolve(__dirname, 'mediamtx-key.pem');

// Only write the key file if it doesn't already exist
if (!fs.existsSync(keyPath)) {
  console.log("🔐 Writing EC2 private key from environment variable...");

  fs.writeFileSync(keyPath, process.env.EC2_KEY, {
    mode: 0o600, // Secure file permissions
  });
}

/* ------------------------------------------------------------------
   SSH CONNECTION TO EC2
------------------------------------------------------------------ */
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
        privateKey: fs.readFileSync(keyPath)
      });
  });
};

/* ------------------------------------------------------------------
   PROXY ENDPOINTS FOR HLS STREAMS
------------------------------------------------------------------ */

// Proxy for .m3u8 playlist files
app.get('/proxy/hls/:streamId/:file', (req, res) => {
  const { streamId, file } = req.params;
  const targetUrl = `http://3.16.91.248:8888/${streamId}/${file}`;
  
  console.log(`🔁 Proxying HLS request: ${streamId}/${file}`);
  
  // Set appropriate headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/MP2T');
  res.setHeader('Cache-Control', 'no-cache');
  
  const proxyReq = http.get(targetUrl, (proxyRes) => {
    console.log(`✅ Proxy success: ${proxyRes.statusCode} for ${streamId}/${file}`);
    res.status(proxyRes.statusCode);
    proxyRes.pipe(res);
  }).on('error', (err) => {
    console.log(`❌ Proxy error for ${streamId}/${file}:`, err.message);
    res.status(500).json({ error: `Proxy error: ${err.message}` });
  });
  
  proxyReq.on('timeout', () => {
    console.log(`⏰ Proxy timeout for ${streamId}/${file}`);
    proxyReq.destroy();
    res.status(504).json({ error: 'Proxy timeout' });
  });
});

// Proxy for segment files (.ts files)
app.get('/proxy/segment/:streamId/:segment', (req, res) => {
  const { streamId, segment } = req.params;
  const targetUrl = `http://3.16.91.248:8888/${streamId}/${segment}`;
  
  console.log(`🔁 Proxying segment: ${streamId}/${segment}`);
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'video/MP2T');
  res.setHeader('Cache-Control', 'no-cache');
  
  http.get(targetUrl, (proxyRes) => {
    res.status(proxyRes.statusCode);
    proxyRes.pipe(res);
  }).on('error', (err) => {
    console.log(`❌ Segment proxy error:`, err.message);
    res.status(500).json({ error: 'Segment proxy error' });
  });
});

// Main proxy endpoint that returns the m3u8 playlist
app.get('/proxy/stream/:streamId', (req, res) => {
  const streamId = req.params.streamId;
  const targetUrl = `http://3.16.91.248:8888/${streamId}/index.m3u8`;
  
  console.log(`🔁 Proxying stream: ${streamId}`);
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  
  http.get(targetUrl, (proxyRes) => {
    console.log(`✅ Stream proxy success: ${proxyRes.statusCode} for ${streamId}`);
    res.status(proxyRes.statusCode);
    proxyRes.pipe(res);
  }).on('error', (err) => {
    console.log(`❌ Stream proxy error for ${streamId}:`, err.message);
    res.status(500).json({ error: `Stream proxy error: ${err.message}` });
  });
});

/* ------------------------------------------------------------------
   START MEDIAMTX ON EC2 (DETACHED, PERSISTENT)
------------------------------------------------------------------ */
app.post('/start-mt', async (req, res) => {
  try {
    const conn = await connectToEC2();

    const startCommand = `
      nohup setsid env PATH=$PATH:/usr/local/bin \
      /usr/local/bin/mediamtx /home/ec2-user/mediamtx.yml \
      > /home/ec2-user/mediamtx.log 2>&1 < /dev/null &
    `;

    console.log("🚀 Starting MediaMTX on EC2...");

    conn.exec(startCommand, (err) => {
      conn.end();

      if (err) {
        return res.status(500).json({ error: err.message });
      }

      console.log("✅ MediaMTX started in background.");

      // Return HTTPS proxy URLs instead of direct HTTP URLs
      const baseUrl = `https://videostreamingapp-18pd.onrender.com`;
      res.json({
        message: "MediaMTX started successfully",
        streams: [
          `${baseUrl}/proxy/stream/stream1`,
          `${baseUrl}/proxy/stream/stream2`,
          `${baseUrl}/proxy/stream/stream3`,
          `${baseUrl}/proxy/stream/stream4`,
          `${baseUrl}/proxy/stream/stream5`
        ]
      });
    });
  } catch (err) {
    console.log("❌ ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------
   HEALTH CHECK ENDPOINT
------------------------------------------------------------------ */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Video Streaming Proxy Server'
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
      proxyStream: 'GET /proxy/stream/:streamId',
      health: 'GET /health'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`🔒 Proxy endpoints available at: https://videostreamingapp-18pd.onrender.com`);
});