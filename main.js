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
  const iendIdx = buffer.indexOf(iendHeader);
  
  if (iendIdx === -1) return buffer; // broken png?
  
  return Buffer.concat([buffer.slice(0, iendIdx), chunk, buffer.slice(iendIdx)]);
}

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
  console.log("App is ready, creating window...");
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- GenAI Logic ---

ipcMain.handle('generate-image', async (event, { prompt, resolution, ratio, referenceImages }) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('API Key is missing in .env file');
    }

    const ai = new GoogleGenAI({ apiKey });
    const model = 'gemini-3-pro-image-preview';
    
    // Config
    const config = {
      responseModalities: ['IMAGE'], // We only want image
      imageConfig: {
        imageSize: resolution // '1K', '2K' etc
      }
    };

    // Construct Parts
    const parts = [];
    
    // Add text prompt
    // We include aspect ratio in the prompt as instruction since config might not support it explicitly yet
    // or it's safe to reinforce.
    const augmentedPrompt = `${prompt} --aspect-ratio ${ratio}`; 
    parts.push({ text: augmentedPrompt });

    // Add reference images
    // Paths are now relative to the application root
    const inputDir = path.join(__dirname, 'input');
    
    for (const ref of referenceImages) {
        // ref should be { hash, mimeType }
        const ext = mime.getExtension(ref.mimeType);
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
            console.warn(`Reference image not found: ${filePath}`);
            // Optionally throw error or skip
        }
    }

    const contents = [{ role: 'user', parts }];

    console.log('Sending request to Gemini...');
    // Send Request
    const responseStream = await ai.models.generateContentStream({
      model,
      config,
      contents,
    });

    let finalBuffer = null;
    let finalMime = 'image/png'; // default assumption

    console.log('Reading stream...');
    for await (const chunk of responseStream) {
        const cand = chunk.candidates?.[0];
        if (cand?.content?.parts?.[0]?.inlineData) {
            console.log('Received image chunk.');
            const inlineData = cand.content.parts[0].inlineData;
            finalMime = inlineData.mimeType || 'image/png';
            finalBuffer = Buffer.from(inlineData.data || '', 'base64');
            break; // Found the image
        }
    }

    if (!finalBuffer) {
        console.error('No buffer received.');
        throw new Error('No image data received from API.');
    }

    console.log(`Image received. Size: ${finalBuffer.length}, Mime: ${finalMime}`);

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
            console.log('Injecting JPEG metadata...');
            const exifObj = {
                "Exif": {
                    [piexif.ExifIFD.UserComment]: "BananaAppMeta:" + safeMetaString
                }
            };
            const exifBytes = piexif.dump(exifObj);
            const newData = piexif.insert(exifBytes, finalBuffer.toString('binary'));
            savedBuffer = Buffer.from(newData, 'binary');
        } else if (finalMime === 'image/png') {
            console.log('Injecting PNG metadata...');
            savedBuffer = injectPngMetadata(finalBuffer, 'BananaAppMeta', safeMetaString);
        }
    } catch (metaErr) {
        console.error('Metadata injection failed, saving raw image:', metaErr);
        // Fallback to original buffer if injection fails
        savedBuffer = finalBuffer;
    }

    // Save to file
    const fileName = `banana_${Date.now()}.${ext}`;
    // Output path relative to app root
    const savePath = path.join(__dirname, 'output');
    console.log(`Saving to: ${savePath}`);
    
    if (!fs.existsSync(savePath)) {
        console.log('Creating directory...');
        fs.mkdirSync(savePath, { recursive: true });
    }
    
    const fullPath = path.join(savePath, fileName);
    fs.writeFileSync(fullPath, savedBuffer);
    console.log(`File written: ${fullPath}`);

    return { success: true, path: fullPath };

  } catch (error) {
    console.error(error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-paths', () => {
    // Paths relative to app root
    return {
        documents: __dirname,
        inputDir: path.join(__dirname, 'input'),
        outputDir: path.join(__dirname, 'output')
    };
});

ipcMain.handle('list-output-files', () => {
    const outputDir = path.join(__dirname, 'output');
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

ipcMain.handle('list-input-files', () => {
    const inputDir = path.join(__dirname, 'input');
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

ipcMain.handle('download-image', async (event, sourcePath) => {
    try {
        const { dialog } = require('electron');
        const { filePath } = await dialog.showSaveDialog({
            defaultPath: path.basename(sourcePath),
            filters: [{ name: 'Images', extensions: ['png', 'jpg'] }]
        });

        if (filePath) {
            fs.copyFileSync(sourcePath, filePath);
            return { success: true, path: filePath };
        }
        return { success: false, canceled: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});