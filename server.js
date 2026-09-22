const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const multer = require('multer');
const dotenv = require('dotenv');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 8080;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_FILE = path.join(__dirname, 'bot_state.json');

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

app.use(express.static('public'));
app.use(express.json());

let runningProcess = null;
let logHistory = [];
let botState = loadState();

function loadState() {
    if (fs.existsSync(DATA_FILE)) {
        try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
    }
    return { mainFile: null, envVars: {} };
}

function saveState(data) {
    botState = { ...botState, ...data };
    fs.writeFileSync(DATA_FILE, JSON.stringify(botState, null, 2));
}

function addLog(msg, type = 'info') {
    const timestamp = new Date().toTimeString().slice(0, 8);
    const logObj = { time: timestamp, text: msg, type };
    logHistory.push(logObj);
    if (logHistory.length > 400) logHistory.shift();
    io.emit('bot-log', logObj);
}

function getUploadedFiles() {
    if (!fs.existsSync(UPLOAD_DIR)) return [];
    return fs.readdirSync(UPLOAD_DIR).map(file => {
        const stats = fs.statSync(path.join(UPLOAD_DIR, file));
        return { name: file, size: (stats.size / 1024).toFixed(1) + ' KB' };
    });
}

function scanFileForEnvVars(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const varNames = new Set();
    const regex1 = /process\.env\.([A-Z0-9_]+)/g;
    const regex2 = /process\.env\[["']([A-Z0-9_]+)["']\]/g;
    let match;
    while ((match = regex1.exec(content)) !== null) varNames.add(match[1]);
    while ((match = regex2.exec(content)) !== null) varNames.add(match[1]);
    return Array.from(varNames);
}

// REST APIs
app.get('/api/files', (req, res) => {
    res.json({ files: getUploadedFiles(), state: botState });
});

app.post('/api/upload', upload.array('files'), (req, res) => {
    const files = req.files;
    if (!files || files.length === 0) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const allFiles = getUploadedFiles().map(f => f.name);
    let mainFile = botState.mainFile;

    if (!mainFile || !allFiles.includes(mainFile)) {
        if (allFiles.includes('bot.js')) mainFile = 'bot.js';
        else if (allFiles.includes('index.js')) mainFile = 'index.js';
        else if (allFiles.includes('main.js')) mainFile = 'main.js';
        else {
            const jsFile = allFiles.find(f => f.endsWith('.js'));
            if (jsFile) mainFile = jsFile;
        }
    }

    saveState({ mainFile });
    addLog(`Uploaded file(s): ${files.map(f => f.originalname).join(', ')}`, 'ok');

    io.emit('files-updated', { files: getUploadedFiles(), state: botState });
    res.json({ success: true, mainFile, files: getUploadedFiles() });
});

app.delete('/api/files/:name', (req, res) => {
    const filePath = path.join(UPLOAD_DIR, req.params.name);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        addLog(`Deleted file: ${req.params.name}`, 'warn');
        if (botState.mainFile === req.params.name) {
            saveState({ mainFile: null });
        }
    }
    io.emit('files-updated', { files: getUploadedFiles(), state: botState });
    res.json({ success: true });
});

// Socket.io Realtime Layer
io.on('connection', (socket) => {
    socket.emit('init-state', {
        state: botState,
        isRunning: runningProcess !== null,
        files: getUploadedFiles(),
        logs: logHistory
    });

    socket.on('deploy-bot', (data) => {
        if (runningProcess) {
            return addLog('⚠️ Bot is already running! Stop it first before redeploying.', 'warn');
        }

        const files = getUploadedFiles().map(f => f.name);
        const mainFile = data.mainFile || botState.mainFile;

        if (!mainFile || !files.includes(mainFile)) {
            addLog('❌ Deployment failed: No valid .js file found in upload directory.', 'err');
            return io.emit('status-change', { isRunning: false, state: 'stopped' });
        }

        saveState({ mainFile });

        // Parse ENV inputs
        let customEnv = { ...process.env };
        const envPath = path.join(UPLOAD_DIR, '.env');
        
        if (fs.existsSync(envPath)) {
            try {
                const parsedEnv = dotenv.parse(fs.readFileSync(envPath));
                customEnv = { ...customEnv, ...parsedEnv };
                addLog('⚙️ Loaded variables from uploaded .env file.', 'ok');
            } catch (err) {
                addLog(`⚠️ Error parsing .env file: ${err.message}`, 'warn');
            }
        }

        if (data.envText && data.envText.trim()) {
            data.envText.split('\n').forEach(line => {
                const parts = line.split('=');
                if (parts.length >= 2) {
                    customEnv[parts[0].trim()] = parts.slice(1).join('=').trim();
                }
            });
            addLog('⚙️ Applied custom environment variables from input box.', 'ok');
        }

        // Auto Detection & Warning System
        const requiredVars = scanFileForEnvVars(path.join(UPLOAD_DIR, mainFile));
        const missingVars = requiredVars.filter(v => !customEnv[v]);

        if (missingVars.length > 0) {
            addLog(`⚠️ WARNING: Code uses ${missingVars.join(', ')} but no values were provided!`, 'warn');
        }

        addLog(`🚀 Launching bot process: node ${mainFile}`, 'sys');

        runningProcess = spawn('node', [mainFile], {
            env: customEnv,
            cwd: UPLOAD_DIR
        });

        io.emit('status-change', { isRunning: true, state: 'running' });

        runningProcess.stdout.on('data', (data) => {
            data.toString().split('\n').forEach(line => {
                if (line.trim()) addLog(line.trim(), 'info');
            });
        });

        runningProcess.stderr.on('data', (data) => {
            data.toString().split('\n').forEach(line => {
                if (line.trim()) addLog(`[STDERR] ${line.trim()}`, 'err');
            });
        });

        runningProcess.on('close', (code) => {
            addLog(`🛑 Bot process exited with code ${code}`, code === 0 ? 'info' : 'err');
            runningProcess = null;
            io.emit('status-change', { isRunning: false, state: 'stopped' });
        });
    });

    socket.on('stop-bot', () => {
        if (runningProcess) {
            runningProcess.kill('SIGTERM');
            runningProcess = null;
            addLog('🛑 Bot process manually stopped by user.', 'warn');
            io.emit('status-change', { isRunning: false, state: 'stopped' });
        }
    });

    socket.on('clear-logs', () => {
        logHistory = [];
        io.emit('logs-cleared');
    });
});

server.listen(PORT, () => {
    console.log(`🚀 KALYAN HOSTERS LIVE on port ${PORT}`);
});
