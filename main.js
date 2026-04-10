const { app, BrowserWindow, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const piexif = require('piexifjs');
const {
  getProvider,
  listProviders,
  listUniqueVendors,
  isValidProviderId,
  DEFAULT_ID,
  normalizeProviderId
} = require('./providers/registry');
const { finalizeAndSaveImage } = require('./lib/imagePipeline');
const { KieUploadCacheSqlite } = require('./lib/kieUploadCacheSqlite');
const { withVendorJobGate } = require('./lib/vendorJobGate');
const {
  mergeVendorJobLimits,
  clampVendorLimitEntry,
  validateVendorJobLimitsPayload,
  FALLBACK_DEFAULT
} = require('./lib/vendorLimitsDefaults');
const kieProvider = require('./providers/kie_nano_banana_pro');
require('dotenv').config();

let kieUploadCacheSingleton = null;
function getKieUploadCache() {
  if (!kieUploadCacheSingleton) {
    kieUploadCacheSingleton = new KieUploadCacheSqlite(
      path.join(app.getPath('userData'), 'kie-upload-cache.sqlite')
    );
  }
  return kieUploadCacheSingleton;
}

// Disable hardware acceleration to prevent GPU process crashes
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-gl', 'swiftshader');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-features', 'Autofill');

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
    return { debugMode: false, imageProvider: DEFAULT_ID };
}

function saveConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let appConfig = loadConfig();
if (!appConfig.imageProvider) appConfig.imageProvider = DEFAULT_ID;
else {
  const normalized = normalizeProviderId(appConfig.imageProvider);
  if (normalized && normalized !== appConfig.imageProvider) {
    appConfig.imageProvider = normalized;
    saveConfig(appConfig);
  }
}

function writeEnvKey(envPath, key, value) {
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }
  const lines = envContent.split(/\r?\n/);
  const prefix = `${key}=`;
  let found = false;
  const newLines = lines.map((line) => {
    if (line.startsWith(prefix)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) newLines.push(`${key}=${value}`);
  fs.writeFileSync(envPath, newLines.join('\n'));
}

function apiKeyForProvider(providerId) {
  if (providerId === 'ai_studio_nano_banana_pro') return process.env.GEMINI_API_KEY;
  if (providerId === 'kie_nano_banana_pro') return process.env.KIE_AI_API_KEY;
  return undefined;
}

function getEffectiveVendorJobLimits() {
  return mergeVendorJobLimits(appConfig.vendorJobLimits || {}, listUniqueVendors());
}

function gateLimitsFromRow(row) {
  return {
    maxConcurrent: row.maxConcurrent,
    maxStartsPerWindow: row.maxStartsPerWindow,
    windowMs: row.windowMs
  };
}

// Custom logger
const logger = {
    log: (...args) => { if (appConfig.debugMode) console.log(...args); },
    error: (...args) => { if (appConfig.debugMode) console.error(...args); },
    warn: (...args) => { if (appConfig.debugMode) console.warn(...args); }
};

ipcMain.handle('get-settings', () => {
    const gem = process.env.GEMINI_API_KEY;
    const kie = process.env.KIE_AI_API_KEY;
    return {
        debugMode: appConfig.debugMode,
        resolution: appConfig.resolution,
        aspectRatio: appConfig.aspectRatio,
        imageProvider: normalizeProviderId(appConfig.imageProvider) || appConfig.imageProvider || DEFAULT_ID,
        availableProviders: listProviders(),
        vendorJobLimits: getEffectiveVendorJobLimits(),
        hasGeminiApiKey: Boolean(gem && String(gem).trim()),
        hasKieApiKey: Boolean(kie && String(kie).trim())
    };
});

ipcMain.handle(
  'save-settings',
  async (event, { apiKey, kieApiKey, debugMode, resolution, aspectRatio, imageProvider, vendorJobLimits }) => {
    if (vendorJobLimits != null && !validateVendorJobLimitsPayload(vendorJobLimits)) {
      return { success: false, error: 'Invalid vendor job limit settings' };
    }

    appConfig.debugMode = debugMode;
    if (resolution) appConfig.resolution = resolution;
    if (aspectRatio) appConfig.aspectRatio = aspectRatio;
    if (imageProvider && isValidProviderId(imageProvider)) {
      appConfig.imageProvider = normalizeProviderId(imageProvider) || imageProvider;
    }

    if (vendorJobLimits != null) {
      const known = listUniqueVendors();
      const base = mergeVendorJobLimits(appConfig.vendorJobLimits || {}, known);
      for (const v of known) {
        const incoming = vendorJobLimits[v];
        if (incoming && typeof incoming === 'object') {
          base[v] = clampVendorLimitEntry({ ...base[v], ...incoming });
        }
      }
      appConfig.vendorJobLimits = base;
    }

    saveConfig(appConfig);

    const envPath = path.join(__dirname, '.env');

    if (apiKey && apiKey.trim()) {
        writeEnvKey(envPath, 'GEMINI_API_KEY', apiKey.trim());
        process.env.GEMINI_API_KEY = apiKey.trim();
    }

    if (kieApiKey && kieApiKey.trim()) {
        writeEnvKey(envPath, 'KIE_AI_API_KEY', kieApiKey.trim());
        process.env.KIE_AI_API_KEY = kieApiKey.trim();
    }

    return { success: true };
  }
);

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

ipcMain.handle('generate-image', async (event, { prompt, resolution, ratio, referenceImages, project, provider: providerFromPayload }) => {
  try {
    const providerId = providerFromPayload || process.env.IMAGE_PROVIDER || appConfig.imageProvider || DEFAULT_ID;
    const provider = getProvider(providerId);

    const vendorKey = provider.vendor || 'default';
    let limitsRow = getEffectiveVendorJobLimits()[vendorKey];
    if (!limitsRow) {
      limitsRow = clampVendorLimitEntry({ ...FALLBACK_DEFAULT });
    }

    return await withVendorJobGate(vendorKey, gateLimitsFromRow(limitsRow), async () => {
      const { input: inputDir, output: outputDir } = getProjectPaths(project);

      const parts = provider.buildRequestParts(prompt, inputDir, referenceImages, {
        warn: (msg) => logger.warn(msg)
      });

      const apiKey = apiKeyForProvider(provider.id);

      const kieUploadCache = provider.vendor === 'kie_ai' ? getKieUploadCache() : null;

      const sendDebug = (label, data) => {
        event.sender.send('debug-log', label, data);
      };

      const sendRequestLog = (msg) => {
        try {
          if (event.sender && !event.sender.isDestroyed()) {
            event.sender.send('request-log', msg);
          }
        } catch (_) {
          /* ignore */
        }
      };

      const { buffer, mimeType } = await provider.generateImage({
        apiKey,
        vendor: provider.vendor,
        kieUploadCache,
        prompt,
        resolution,
        ratio,
        parts,
        inputDir,
        referenceImages,
        logger,
        sendDebug,
        sendRequestLog,
        pollIntervalMs: limitsRow.pollIntervalMs
      });

      const metaData = {
        prompt,
        resolution,
        ratio,
        provider: provider.id,
        referenceImages: referenceImages.map((ref) => ({
          hash: ref.hash,
          mimeType: ref.mimeType
        }))
      };

      const fullPath = await finalizeAndSaveImage({
        nativeImage,
        piexif,
        buffer,
        mimeType,
        metaData,
        outputDir,
        logger
      });

      return { success: true, path: fullPath };
    });
  } catch (error) {
    logger.error(error);
    const out = { success: false, error: error.message };
    if (error.kieTaskId) out.kieTaskId = error.kieTaskId;
    return out;
  }
});

ipcMain.handle(
  'kie-recover-task',
  async (event, { taskId, prompt, resolution, ratio, referenceImages, project }) => {
    try {
      if (!taskId || typeof taskId !== 'string') {
        return { success: false, error: 'taskId required' };
      }
      const apiKey = process.env.KIE_AI_API_KEY;
      if (!apiKey || !String(apiKey).trim()) {
        return { success: false, error: 'Kie.ai API key is missing' };
      }

      const vendorKey = 'kie_ai';
      let limitsRow = getEffectiveVendorJobLimits()[vendorKey];
      if (!limitsRow) {
        limitsRow = clampVendorLimitEntry({ ...FALLBACK_DEFAULT });
      }

      return await withVendorJobGate(vendorKey, gateLimitsFromRow(limitsRow), async () => {
        const rec = await kieProvider.fetchKieTaskRecordOnce(apiKey.trim(), taskId);
        if (!rec.ok) {
          return { success: false, error: rec.msg || 'Kie recordInfo failed' };
        }

        const { state, failMsg, resultJson } = rec.data;

        if (state === 'fail') {
          return { success: false, error: failMsg || 'Kie generation failed' };
        }

        if (state === 'success' && resultJson) {
          const url = kieProvider.resultImageUrlFromRecordData(rec.data);
          const { buffer, mimeType } = await kieProvider.downloadResult(url);
          const { output: outputDir } = getProjectPaths(project);
          const metaData = {
            prompt,
            resolution,
            ratio,
            provider: kieProvider.id,
            referenceImages: (referenceImages || []).map((ref) => ({
              hash: ref.hash,
              mimeType: ref.mimeType
            }))
          };
          const fullPath = await finalizeAndSaveImage({
            nativeImage,
            piexif,
            buffer,
            mimeType,
            metaData,
            outputDir,
            logger
          });
          return { success: true, path: fullPath };
        }

        return { success: false, stillPending: true };
      });
    } catch (error) {
      logger.error(error);
      return { success: false, error: error.message };
    }
  }
);

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