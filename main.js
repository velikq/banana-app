const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');
const mime = require('mime').default;
const piexif = require('piexifjs');
require('dotenv').config();

// Disable hardware acceleration to prevent GPU process crashes
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-gl', 'swiftshader');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-features', 'Autofill');

app.commandLine.appendSwitch('proxy-server', `127.0.0.1:2080`);

// --- utils for PNG Metadata ---
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) c = 0xedb88320 ^ (c >>> 1);
    else c = c >>> 1;
  }
  crcTable[n] = c;
}
function crc32(buf) {
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ (-1)) >>> 0;
}

function injectPngMetadata(buffer, key, value) {
  // Create tEXt chunk
  // Data format: Keyword + null separator + Text
  const keyBuf = Buffer.from(key, 'latin1');
  const valBuf = Buffer.from(value, 'latin1'); // standard tEXt is Latin-1. 
  
  const dataLen = keyBuf.length + 1 + valBuf.length;
  const chunkLen = 4 + 4 + dataLen + 4; // Len + Type + Data + CRC
  
  const chunk = Buffer.alloc(chunkLen);
  
  // Length
  chunk.writeUInt32BE(dataLen, 0);
  // Type
  chunk.write('tEXt', 4);
  // Data
  let offset = 8;
  keyBuf.copy(chunk, offset);
  offset += keyBuf.length;
  chunk.writeUInt8(0, offset); // null separator
  offset += 1;
  valBuf.copy(chunk, offset);
  
  // CRC (calculated on Type + Data)
  const crcVal = crc32(chunk.slice(4, 4 + 4 + dataLen));
  chunk.writeUInt32BE(crcVal, 8 + dataLen);
  
  // Insert before IEND (last 12 bytes usually, but let's just find IEND)
  // IEND is 00 00 00 00 49 45 4E 44 AE 42 60 82
  const iendHeader = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44]);
  const iendIdx = buffer.lastIndexOf(iendHeader);
  
  if (iendIdx === -1) return buffer; // broken png?
  
  return Buffer.concat([buffer.slice(0, iendIdx), chunk, buffer.slice(iendIdx)]);
}

// --- Settings Management ---
const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        } catch (e) {
            console.error('Failed to load config:', e);
        }
    }
    return { debugMode: false };
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let appConfig = loadConfig();

// Custom logger
const logger = {
    log: (...args) => { if (appConfig.debugMode) console.log(...args); },
    error: (...args) => { if (appConfig.debugMode) console.error(...args); },
    warn: (...args) => { if (appConfig.debugMode) console.warn(...args); }
};

ipcMain.handle('get-settings', () => {
    return { 
        debugMode: appConfig.debugMode,
        resolution: appConfig.resolution,
        aspectRatio: appConfig.aspectRatio
    };
});

ipcMain.handle('save-settings', async (event, { apiKey, debugMode, resolution, aspectRatio }) => {
    // Save settings
    appConfig.debugMode = debugMode;
    if (resolution) appConfig.resolution = resolution;
    if (aspectRatio) appConfig.aspectRatio = aspectRatio;
    
    saveConfig(appConfig);

    // Save API key if provided
    if (apiKey && apiKey.trim()) {
        const envPath = path.join(__dirname, '.env');
        let envContent = '';
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf8');
        }
        
        const lines = envContent.split(/\r?\n/);
        let keyFound = false;
        const newLines = lines.map(line => {
            if (line.startsWith('GEMINI_API_KEY=')) {
                keyFound = true;
                return `GEMINI_API_KEY=${apiKey.trim()}`;
            }
            return line;
        });
        
        if (!keyFound) {
            newLines.push(`GEMINI_API_KEY=${apiKey.trim()}`);
        }
        
        fs.writeFileSync(envPath, newLines.join('\n'));
        process.env.GEMINI_API_KEY = apiKey.trim(); // Update in current process
    }
    
    return { success: true };
});

// --- Window Management ---
function createWindow () {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false, // Custom title bar
    backgroundColor: '#121212',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
  // mainWindow.webContents.openDevTools(); // Debugging

  // Window Control IPCs
  ipcMain.handle('window-minimize', () => {
    mainWindow.minimize();
  });

  ipcMain.handle('window-maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.handle('window-close', () => {
    mainWindow.close();
  });
}

app.whenReady().then(() => {
  logger.log("App is ready, creating window...");
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- GenAI Logic ---

function getSafeDirectoryName(title) {
    if (!title) return null;
    return title.trim(); // Windows/Linux/Mac handle most chars fine, maybe just trim. 
    // If strict sanitization is desired:
    // return title.trim().replace(/[^a-z0-9 \-_]/gi, '_').toLowerCase();
    // For now, let's stick to simple trim to allow non-latin chars if user wants, 
    // unless it causes issues. But 'create-project' previously used strict sanitization.
    // Let's use the strict one to be safe and consistent with previous attempt.
    // return title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    // Wait, if I change it now, I must stick to one.
    // The requirement didn't specify, but "banana.pots" style implies fun. 
    // Let's use:
    return title.trim().replace(/[\/\\:*?"<>|]/g, '_'); // Basic OS invalid char replacement
}

// Helper to get project paths
function getProjectPaths(projectTitle) {
    const safeName = getSafeDirectoryName(projectTitle);
    if (!safeName) {
        return {
            input: path.join(__dirname, 'input'),
            output: path.join(__dirname, 'output')
        };
    }
    return {
        input: path.join(__dirname, 'input', safeName),
        output: path.join(__dirname, 'output', safeName)
    };
}

ipcMain.handle('get-project-details', (event, title) => {
    return getProjectPaths(title);
});

ipcMain.handle('generate-image', async (event, { prompt, resolution, ratio, referenceImages, project }) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('API Key is missing in .env file');
    }

    const ai = new GoogleGenAI({ 
      apiKey,
      httpOptions: { timeout: 600000 } // 10 minutes timeout for large image generation
    });
    const model = 'gemini-3-pro-image-preview';
    
    // Config
    const config = {
      responseModalities: ['IMAGE'], // We only want image
      imageConfig: {
        imageSize: resolution, // '1K', '2K' etc
        aspectRatio: ratio
      }
    };

    // Construct Parts
    const parts = [];
    
    // Add text prompt
    parts.push({ text: prompt });

    // Add reference images
    // Paths are now relative to the application root or project folder
    // The reference images usually come from the current input directory
    const { input: inputDir } = getProjectPaths(project);
    
    for (const ref of referenceImages) {
        // ref should be { hash, mimeType, extension? }
        const ext = ref.extension || mime.getExtension(ref.mimeType);
        const filename = `${ref.hash}.${ext}`;
        const filePath = path.join(inputDir, filename);

        if (fs.existsSync(filePath)) {
            const fileData = fs.readFileSync(filePath).toString('base64');
             parts.push({
                inlineData: {
                    mimeType: ref.mimeType,
                    data: fileData
                }
            });
        } else {
            logger.warn(`Reference image not found: ${filePath}`);
            // Check global input dir as fallback?
            // For now, strict project scope.
        }
    }

    const contents = parts;

    // Send contents to renderer console for debugging
    event.sender.send('debug-log', 'Contents being sent to Gemini:', JSON.stringify(contents, null, 2));

    logger.log('Sending request to Gemini...');
    // Send Request
    const responseStream = await ai.models.generateContentStream({
      model,
      config,
      contents,
    });

    let finalBuffer = null;
    let finalMime = 'image/png'; // default assumption

    logger.log('Reading stream...');
    let collectedText = '';
    for await (const chunk of responseStream) {
        const cand = chunk.candidates?.[0];
        if (cand?.content?.parts) {
            for (const part of cand.content.parts) {
                if (part.inlineData) {
                    logger.log('Received image chunk.');
                    const inlineData = part.inlineData;
                    finalMime = inlineData.mimeType || 'image/png';
                    finalBuffer = Buffer.from(inlineData.data || '', 'base64');
                }
                if (part.text) {
                    collectedText += part.text;
                }
            }
        }
        if (finalBuffer) break;
    }

    if (!finalBuffer) {
        if (collectedText) {
            logger.error('API returned text instead of image:', collectedText);
            event.sender.send('debug-log', 'API Response Text:', collectedText);
        }
        logger.error('No buffer received.');
        throw new Error('No image data received from API.');
    }

    logger.log(`Image received. Size: ${finalBuffer.length}, Mime: ${finalMime}`);

    // --- Inject Metadata ---
    // Data to save
    // We only save minimal info: prompt, resolution, ratio, and reference hashes
    const metaData = {
        prompt,
        resolution,
        ratio,
        referenceImages: referenceImages.map(ref => ({
            hash: ref.hash,
            mimeType: ref.mimeType
        }))
    };
    
    const metaString = JSON.stringify(metaData);
    const safeMetaString = Buffer.from(metaString).toString('base64');

    let savedBuffer = finalBuffer;
    const ext = mime.getExtension(finalMime);

    try {
        if (finalMime === 'image/jpeg') {
            logger.log('Injecting JPEG metadata...');
            const exifObj = {
                "Exif": {
                    [piexif.ExifIFD.UserComment]: "BananaAppMeta:" + safeMetaString
                }
            };
            const exifBytes = piexif.dump(exifObj);
            const newData = piexif.insert(exifBytes, finalBuffer.toString('binary'));
            savedBuffer = Buffer.from(newData, 'binary');
        } else if (finalMime === 'image/png') {
            logger.log('Injecting PNG metadata...');
            savedBuffer = injectPngMetadata(finalBuffer, 'BananaAppMeta', safeMetaString);
        }
    } catch (metaErr) {
        logger.error('Metadata injection failed, saving raw image:', metaErr);
        // Fallback to original buffer if injection fails
        savedBuffer = finalBuffer;
    }

    // Save to file
    const fileName = `banana_${Date.now()}.${ext}`;
    // Output path relative to app root or project
    const { output: savePath } = getProjectPaths(project);
    logger.log(`Saving to: ${savePath}`);
    
    await fs.promises.mkdir(savePath, { recursive: true });
    
    const fullPath = path.join(savePath, fileName);
    await fs.promises.writeFile(fullPath, savedBuffer);
    logger.log(`File written: ${fullPath}`);

    return { success: true, path: fullPath };

  } catch (error) {
    logger.error(error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-paths', () => {
    // Paths relative to app root
    return {
        documents: __dirname,
        inputDir: path.join(__dirname, 'input'),
        outputDir: path.join(__dirname, 'output'),
        projectsDir: path.join(__dirname, 'projects')
    };
});

ipcMain.handle('delete-file', async (event, filePath) => {
    try {
        if (!fs.existsSync(filePath)) {
            throw new Error('File not found');
        }
        await fs.promises.unlink(filePath);
        return { success: true };
    } catch (error) {
        logger.error(`Failed to delete file ${filePath}:`, error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('list-output-files', (event, project) => {
    const { output: outputDir } = getProjectPaths(project);
    if (!fs.existsSync(outputDir)) return [];
    
    const files = fs.readdirSync(outputDir)
        .filter(file => /\.(png|jpe?g)$/i.test(file))
        .map(file => {
            const fullPath = path.join(outputDir, file);
            const stats = fs.statSync(fullPath);
            return {
                name: file,
                path: fullPath,
                mtime: stats.mtimeMs
            };
        })
        .sort((a, b) => b.mtime - a.mtime); // Newest first
        
    return files;
});

ipcMain.handle('list-input-files', (event, project) => {
    const { input: inputDir } = getProjectPaths(project);
    if (!fs.existsSync(inputDir)) return [];
    
    const files = fs.readdirSync(inputDir)
        .filter(file => /\.(png|jpe?g)$/i.test(file))
        .map(file => {
            const fullPath = path.join(inputDir, file);
            const stats = fs.statSync(fullPath);
            return {
                name: file,
                path: fullPath,
                mtime: stats.mtimeMs
            };
        })
        .sort((a, b) => b.mtime - a.mtime); // Newest first
        
    return files;
});

// --- Projects Logic ---
const PROJECTS_DIR = path.join(__dirname, 'projects');
const PROJECTS_FILE = path.join(PROJECTS_DIR, 'projects.json');

function getProjectsData() {
    if (!fs.existsSync(PROJECTS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function saveProjectsData(data) {
    if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2));
}

ipcMain.handle('list-projects', () => {
    const projects = getProjectsData();
    // Return full paths for images
    return projects.map(p => ({
        ...p,
        imagePath: path.join(PROJECTS_DIR, p.imageName)
    }));
});

ipcMain.handle('create-project', async (event, { title, sourceImagePath }) => {
    try {
        if (!title) throw new Error("Title is required");
        if (!sourceImagePath) throw new Error("Preview image is required");

        // 1. Create Directories
        const { input: inputDir, output: outputDir } = getProjectPaths(title);
        if (!fs.existsSync(inputDir)) fs.mkdirSync(inputDir, { recursive: true });
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        // 2. Save Preview Image to projects dir
        if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
        
        const ext = path.extname(sourceImagePath);
        const safeTitle = getSafeDirectoryName(title);
        const imageName = `${safeTitle}_preview${ext}`;
        const targetImagePath = path.join(PROJECTS_DIR, imageName);
        
        fs.copyFileSync(sourceImagePath, targetImagePath);

        // 3. Update JSON
        const projects = getProjectsData();
        if (projects.some(p => p.title === title)) {
            throw new Error("Project with this title already exists");
        }
        
        projects.push({
            title,
            imageName
        });
        
        saveProjectsData(projects);

        return { success: true };

    } catch (err) {
        logger.error("Failed to create project:", err);
        return { success: false, error: err.message };
    }
});