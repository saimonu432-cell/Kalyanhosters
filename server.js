const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Upload directory setup
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let activeProcess = null;
let mainBotFile = null;
let logsHistory = [];

// Console logs maintain karne ke liye
function addLog(text, type = 'info') {
  const time = new Date().toTimeString().slice(0, 8);
  const logObj = { text, type, time };
  logsHistory.push(logObj);
  if (logsHistory.length > 200) logsHistory.shift();
  io.emit('bot-log', logObj);
}

// Folder mein files check karne ke liye
function getUploadedFiles() {
  if (!fs.existsSync(UPLOAD_DIR)) return [];
  return fs.readdirSync(UPLOAD_DIR).map(file => {
    const stats = fs.statSync(path.join(UPLOAD_DIR, file));
    return { name: file, size: (stats.size / 1024).toFixed(1) + ' KB' };
  });
}

// Auto-detect Python ya JS file
function detectMainFile() {
  const files = getUploadedFiles();
  const py = files.find(f => f.name.endsWith('.py'));
  const js = files.find(f => f.name.endsWith('.js'));
  return py ? py.name : (js ? js.name : null);
}

app.post('/api/upload', upload.array('files'), (req, res) => {
  mainBotFile = detectMainFile();
  const files = getUploadedFiles();
  io.emit('files-updated', { files, state: { mainFile: mainBotFile } });
  res.json({ success: true, files, mainFile: mainBotFile });
});

app.get('/api/files', (req, res) => {
  mainBotFile = detectMainFile();
  res.json({ files: getUploadedFiles(), state: { mainFile: mainBotFile } });
});

app.delete('/api/files/:name', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.name);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  
  mainBotFile = detectMainFile();
  const files = getUploadedFiles();
  io.emit('files-updated', { files, state: { mainFile: mainBotFile } });
  res.json({ success: true, files, mainFile: mainBotFile });
});

// Socket.io for Real-time Console
io.on('connection', (socket) => {
  socket.emit('init-state', {
    files: getUploadedFiles(),
    isRunning: !!activeProcess,
    logs: logsHistory,
    state: { mainFile: mainBotFile }
  });

  socket.on('deploy-bot', ({ mainFile, envText }) => {
    if (activeProcess) {
      addLog('Bot pehle se hi run ho raha hai!', 'warn');
      return;
    }

    let targetFile = mainFile || detectMainFile();

    if (!targetFile) {
      addLog('❌ Error: Upload folder mein koi .py ya .js file nahi mili!', 'err');
      return;
    }

    const envVars = { ...process.env };
    if (envText) {
      envText.split('\n').forEach(line => {
        const [k, ...v] = line.split('=');
        if (k && v.length) envVars[k.trim()] = v.join('=').trim();
      });
    }

    const filePath = path.join(UPLOAD_DIR, targetFile);
    const isPython = targetFile.endsWith('.py');
    
    // Windows vs Linux/Mac OS check for Python
    let cmd = 'node';
    if (isPython) {
       cmd = process.platform === 'win32' ? 'python' : 'python3';
    }

    addLog(`🚀 Starting ${isPython ? 'Python' : 'Node.js'} Bot: ${targetFile}`, 'sys');

    try {
        activeProcess = spawn(cmd, [filePath], { cwd: UPLOAD_DIR, env: envVars });
        io.emit('status-change', { isRunning: true });

        activeProcess.stdout.on('data', (data) => addLog(data.toString().trim(), 'info'));
        activeProcess.stderr.on('data', (data) => addLog(data.toString().trim(), 'err'));

        activeProcess.on('close', (code) => {
          addLog(`Bot ruk gaya (Exit Code: ${code})`, 'warn');
          activeProcess = null;
          io.emit('status-change', { isRunning: false });
        });

        // Agar python system mein install nahi hai toh server crash nahi hoga
        activeProcess.on('error', (err) => {
          addLog(`❌ Process start fail ho gaya: ${err.message}`, 'err');
          if (isPython) addLog(`Hint: Check karo ki Python PC/Server mein install hai ya nahi.`, 'warn');
          activeProcess = null;
          io.emit('status-change', { isRunning: false });
        });

    } catch (error) {
        addLog(`❌ Execution error: ${error.message}`, 'err');
    }
  });

  socket.on('stop-bot', () => {
    if (activeProcess) {
      activeProcess.kill('SIGKILL'); // Bot ko force stop karne ke liye
      activeProcess = null;
      addLog('Bot ko stop kar diya gaya hai.', 'warn');
      io.emit('status-change', { isRunning: false });
    }
  });

  socket.on('clear-logs', () => {
    logsHistory = [];
    io.emit('logs-cleared');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server started at http://localhost:${PORT}`);
});
