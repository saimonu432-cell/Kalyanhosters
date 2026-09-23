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

function addLog(text, type = 'info') {
  const time = new Date().toTimeString().slice(0, 8);
  const logObj = { text, type, time };
  logsHistory.push(logObj);
  if (logsHistory.length > 300) logsHistory.shift();
  io.emit('bot-log', logObj);
}

function getUploadedFiles() {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) return [];
    return fs.readdirSync(UPLOAD_DIR).map(file => {
      const stats = fs.statSync(path.join(UPLOAD_DIR, file));
      return { name: file, size: (stats.size / 1024).toFixed(1) + ' KB' };
    });
  } catch (e) {
    return [];
  }
}

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

// FIXED: Handles both single files and sub-folders cleanly
app.delete('/api/files/:name', (req, res) => {
  try {
    const filePath = path.join(UPLOAD_DIR, req.params.name);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error("Delete error:", err.message);
  }

  mainBotFile = detectMainFile();
  const files = getUploadedFiles();
  io.emit('files-updated', { files, state: { mainFile: mainBotFile } });
  res.json({ success: true, files, mainFile: mainBotFile });
});

io.on('connection', (socket) => {
  socket.emit('init-state', {
    files: getUploadedFiles(),
    isRunning: !!activeProcess,
    logs: logsHistory,
    state: { mainFile: mainBotFile }
  });

  socket.on('deploy-bot', ({ mainFile, envText }) => {
    if (activeProcess) {
      try {
        activeProcess.kill('SIGKILL');
      } catch (e) {}
      activeProcess = null;
    }

    let targetFile = mainFile || detectMainFile();

    if (!targetFile) {
      addLog('❌ Error: Upload directory mein koi .py ya .js file nahi mili!', 'err');
      return;
    }

    // Set PYTHONUNBUFFERED=1 for instant output & PORT=8081 to avoid Flask conflict
    const envVars = { ...process.env, PYTHONUNBUFFERED: "1", PORT: "8081" };

    if (envText) {
      envText.split('\n').forEach(line => {
        const index = line.indexOf('=');
        if (index > 0) {
          const k = line.substring(0, index).trim();
          const v = line.substring(index + 1).trim();
          if (k) envVars[k] = v;
        }
      });
    }

    const filePath = path.join(UPLOAD_DIR, targetFile);
    const isPython = targetFile.endsWith('.py');

    let cmd = 'node';
    let args = [filePath];

    if (isPython) {
      cmd = process.platform === 'win32' ? 'python' : 'python3';
      args = ['-u', filePath];
    }

    addLog(`🚀 Starting ${isPython ? 'Python' : 'Node.js'} Bot: ${targetFile}`, 'sys');

    try {
      activeProcess = spawn(cmd, args, { cwd: UPLOAD_DIR, env: envVars });
      io.emit('status-change', { isRunning: true });

      activeProcess.stdout.on('data', (data) => addLog(data.toString().trim(), 'info'));
      activeProcess.stderr.on('data', (data) => addLog(data.toString().trim(), 'err'));

      activeProcess.on('close', (code) => {
        addLog(`🛑 Bot stop ho gaya (Exit Code: ${code})`, 'warn');
        activeProcess = null;
        io.emit('status-change', { isRunning: false });
      });

      activeProcess.on('error', (err) => {
        addLog(`❌ Process start fail ho gaya: ${err.message}`, 'err');
        activeProcess = null;
        io.emit('status-change', { isRunning: false });
      });

    } catch (error) {
      addLog(`❌ Execution error: ${error.message}`, 'err');
      activeProcess = null;
      io.emit('status-change', { isRunning: false });
    }
  });

  socket.on('stop-bot', () => {
    if (activeProcess) {
      try {
        activeProcess.kill('SIGKILL');
      } catch (e) {}
      activeProcess = null;
      addLog('🛑 Bot ko stop kar diya gaya hai.', 'warn');
      io.emit('status-change', { isRunning: false });
    }
  });

  socket.on('clear-logs', () => {
    logsHistory = [];
    io.emit('logs-cleared');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server started on port ${PORT}`);
});
         
