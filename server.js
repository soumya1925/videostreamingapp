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
const keyPath = path.resolve(__dirname, process.env.EC2_KEY_PATH || 'mediamtx-key.pem');

if (!fs.existsSync(keyPath)) {
  console.log("🔐 Writing EC2 private key from environment variable...");
  if (process.env.EC2_KEY) {
    fs.writeFileSync(keyPath, process.env.EC2_KEY, { mode: 0o600 });
  }
}

/* ------------------------------------------------------------------
   SSH CONNECTION TO EC2
------------------------------------------------------------------ */
const connectToEC2 = () => {
  return new Promise((resolve, reject) => {
    if (!process.env.EC2_HOST || !process.env.EC2_USER || !fs.existsSync(keyPath)) {
      reject(new Error("Missing required environment variables or key file"));
      return;
    }

    const conn = new Client();
    console.log("🔄 Connecting to EC2...");

    conn
      .on('ready', () => {
        console.log("✅ SSH CONNECTION ESTABLISHED with EC2");
        resolve(conn);
      })
      .on('error', reject)
      .connect({
        host: process.env.EC2_HOST,
        username: process.env.EC2_USER,
        privateKey: fs.readFileSync(keyPath)
      });
  });
};

/* ------------------------------------------------------------------
   COMPLETE HLS PROXY SOLUTION
------------------------------------------------------------------ */

// Proxy for m3u8 playlists - rewrite URLs to use our proxy
app.get('/proxy/stream/:streamId', async (req, res) => {
  const { streamId } = req.params;
  const targetUrl = `http://3.16.91.248:8888/${streamId}/index.m3u8`;
  
  console.log(`🔁 Proxying playlist: ${streamId}`);
  
  try {
    const playlist = await fetchPlaylist(targetUrl);
    
    // Rewrite all URLs in the playlist to use our proxy
    const rewrittenPlaylist = playlist.replace(
      /(\w+\.(m3u8|ts))/g, 
      `/proxy/segment/${streamId}/$1`
    );
    
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(rewrittenPlaylist);
  } catch (error) {
    console.log(`❌ Playlist proxy error:`, error.message);
    res.status(500).json({ error: 'Failed to proxy playlist' });
  }
});

// Proxy for segments (.ts files and nested .m3u8 files)
app.get('/proxy/segment/:streamId/:filename', (req, res) => {
  const { streamId, filename } = req.params;
  const targetUrl = `http://3.16.91.248:8888/${streamId}/${filename}`;
  
  console.log(`🔁 Proxying segment: ${streamId}/${filename}`);
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  
  // Set appropriate content type
  if (filename.endsWith('.m3u8')) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  } else if (filename.endsWith('.ts')) {
    res.setHeader('Content-Type', 'video/MP2T');
  }
  
  http.get(targetUrl, (proxyRes) => {
    res.status(proxyRes.statusCode);
    proxyRes.pipe(res);
  }).on('error', (err) => {
    console.log(`❌ Segment proxy error:`, err.message);
    res.status(500).json({ error: 'Proxy error' });
  });
});

// Helper function to fetch playlist
function fetchPlaylist(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let data = '';
      response.on('data', (chunk) => data += chunk);
      response.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

/* ------------------------------------------------------------------
   START MEDIAMTX ON EC2
------------------------------------------------------------------ */
app.post('/start-mt', async (req, res) => {
  try {
    const conn = await connectToEC2();
    const startCommand = process.env.HLS_COMMAND;

    console.log("🚀 Starting MediaMTX on EC2...");

    conn.exec(startCommand, (err, stream) => {
      if (err) {
        conn.end();
        return res.status(500).json({ error: err.message });
      }

      stream.on('close', () => {
        conn.end();
        console.log("✅ MediaMTX startup completed");
        
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
    });
  } catch (err) {
    console.log("❌ ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------
   HEALTH CHECK & DEFAULT ROUTES
------------------------------------------------------------------ */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    proxy: 'HLS proxy is running'
  });
});

app.get('/', (req, res) => {
  res.json({ 
    message: "Express API with HLS Proxy is running!",
    endpoints: {
      startMediaMTX: 'POST /start-mt',
      proxyStream: 'GET /proxy/stream/:streamId',
      health: 'GET /health'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`🔒 HLS Proxy available at: https://videostreamingapp-18pd.onrender.com`);
});