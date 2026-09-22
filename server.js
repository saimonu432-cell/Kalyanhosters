const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// Bot save karne ke liye 'uploads' folder auto-create hoga
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

let activeBot = null; 

// API: File Upload & Deploy
app.post('/deploy', upload.single('botFile'), (req, res) => {
    const envData = req.body.envData || '';
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'File is required' });

    // .env file save karo (taki bot usko read kar sake)
    if (envData.trim() !== '') {
        fs.writeFileSync(path.join(uploadDir, '.env'), envData);
    }
    
    res.json({ message: 'Deployed Successfully', filename: file.originalname });
});

// API: Bot Start
app.post('/start', (req, res) => {
    const { filename } = req.body;
    if (activeBot) return res.json({ message: 'Bot already running' });

    const filePath = path.join(uploadDir, filename);
    const isPython = filename.endsWith('.py');
    const command = isPython ? 'python' : 'node'; 

    try {
        activeBot = spawn(command, [filePath], { cwd: uploadDir });
        io.emit('status', 'running');
        io.emit('log', `[SYSTEM] Starting ${filename} using ${command}...`);

        activeBot.stdout.on('data', (data) => io.emit('log', `[INFO] ${data}`));
        activeBot.stderr.on('data', (data) => {
            io.emit('log', `[WARNING/ERROR] ${data}`);
            io.emit('status', 'warning');
        });

        activeBot.on('close', (code) => {
            io.emit('log', `[SYSTEM] Bot stopped. Exit code: ${code}`);
            io.emit('status', 'stopped');
            activeBot = null;
        });

        res.json({ message: 'Bot Started' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Bot Stop
app.post('/stop', (req, res) => {
    if (activeBot) {
        activeBot.kill();
        activeBot = null;
        io.emit('status', 'stopped');
        io.emit('log', '[SYSTEM] Bot stopped manually by Kalyan.');
    }
    res.json({ message: 'Bot Stopped' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Kalyan Hosters LIVE on port ${PORT}`));

