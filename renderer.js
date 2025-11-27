const { ipcRenderer, webUtils } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const exifr = require('exifr');
const piexif = require('piexifjs');

// --- State ---
let state = {
  resolution: '1K',
  aspectRatio: '1:1',
  prompt: '',
  references: [] // { hash, mimeType, data (base64) }
};

let INPUT_DIR = null;

// --- Init ---
(async () => {
    try {
        const paths = await ipcRenderer.invoke('get-paths');
        INPUT_DIR = paths.inputDir;
        if (!fs.existsSync(INPUT_DIR)) {
            fs.mkdirSync(INPUT_DIR, { recursive: true });
        }
        log(`Input directory ready: ${INPUT_DIR}`);
        
        // Initial library load
        await loadLibrary();
        
    } catch (e) {
        log(`Error initializing paths: ${e.message}`, 'error');
    }
})();

// --- DOM Elements ---
const els = {
  refDrop: document.getElementById('ref-drop-zone'),
  refInput: document.getElementById('ref-file-input'),
  refList: document.getElementById('ref-list'),
  refEmpty: document.getElementById('ref-empty-state'),
  refCount: document.getElementById('ref-count'),
  
  resGroup: document.getElementById('resolution-group'),
  ratioGroup: document.getElementById('ratio-group'),
  
  prompt: document.getElementById('prompt-input'),
  charCounter: document.getElementById('char-counter'),
  
  restoreDrop: document.getElementById('restore-drop-zone'),
  
  generateBtn: document.getElementById('generate-btn'),
  
  previewArea: document.getElementById('image-preview-container'),
  placeholder: document.getElementById('placeholder-state'),
  resultImage: document.getElementById('result-image'),
  spinner: document.getElementById('loading-spinner'),
  tag: document.getElementById('preview-tag'),
  
  downloadArea: document.getElementById('download-area'),
  downloadBtn: document.getElementById('download-btn'),
  
  resetBtn: document.getElementById('reset-btn'),
  libraryList: document.getElementById('library-list'),
  libraryCount: document.getElementById('library-count'),
  
  logs: document.getElementById('logs-output')
};

// --- Logging ---
function log(msg, type = 'info') {
  const div = document.createElement('div');
  div.className = `log-entry log-${type}`;
  const time = new Date().toLocaleTimeString();
  div.textContent = `[${time}] ${msg}`;
  if (els.logs) {
      els.logs.appendChild(div);
      els.logs.scrollTop = els.logs.scrollHeight;
  } else {
      console.log(msg);
  }
}

// --- UI Updates ---
function updateStateUI() {
  // Resolution
  Array.from(els.resGroup.children).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === state.resolution);
  });
  // Ratio
  Array.from(els.ratioGroup.children).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === state.aspectRatio);
  });
  // Prompt
  els.prompt.value = state.prompt || '';
  els.charCounter.textContent = els.prompt.value.length;
  
  // References
  els.refCount.textContent = `${state.references.length} / 9`;
  renderRefList();
}

function renderRefList() {
  els.refList.innerHTML = '';
  
  if (state.references.length === 0) {
      els.refList.classList.add('hidden');
      els.refEmpty.classList.remove('hidden');
  } else {
      els.refList.classList.remove('hidden');
      els.refEmpty.classList.add('hidden');
      
      state.references.forEach((ref, idx) => {
        const container = document.createElement('div');
        container.className = 'ref-thumb-container';
        container.title = 'Click to remove';
        
        const img = document.createElement('img');
        img.src = `data:${ref.mimeType};base64,${ref.data}`;
        img.className = 'ref-thumb';
        
        const overlay = document.createElement('div');
        overlay.className = 'ref-thumb-overlay';
        overlay.textContent = '✕';
        
        container.appendChild(img);
        container.appendChild(overlay);
        
        // Prevent drag events on the image from interfering with the drop zone
        container.addEventListener('click', (e) => {
            e.stopPropagation();
            removeRef(idx);
        });
        
        els.refList.appendChild(container);
      });
  }
}

function removeRef(idx) {
  state.references.splice(idx, 1);
  updateStateUI();
}

// --- Library Management ---
async function loadLibrary() {
    try {
        const files = await ipcRenderer.invoke('list-output-files');
        els.libraryList.innerHTML = '';
        if (els.libraryCount) els.libraryCount.textContent = files.length;
        
        // Start Bar
        const startBar = document.createElement('div');
        startBar.style.height = '2px';
        startBar.style.backgroundColor = 'white';
        startBar.style.marginBottom = '10px';
        startBar.style.flexShrink = '0'; 
        els.libraryList.appendChild(startBar);

        files.forEach((file, idx) => {
            const div = document.createElement('div');
            div.className = 'library-item';
            div.title = `Generated: ${new Date(file.mtime).toLocaleString()}`;
            
            const img = document.createElement('img');
            img.src = `file://${file.path}`; // Load local file
            img.className = 'library-thumb';
            img.loading = 'lazy';

            // Image Counter
            const counterSpan = document.createElement('span');
            counterSpan.className = 'library-item-counter';
            counterSpan.textContent = idx + 1; // 1-based index
            
            // Top Zone: Reference
            const topZone = document.createElement('div');
            topZone.className = 'lib-overlay-top';
            topZone.textContent = 'Reference';
            topZone.addEventListener('click', async (e) => {
                e.stopPropagation();
                await addLibraryImageToReference(file.path);
            });
            
            // Bottom Zone: Context
            const bottomZone = document.createElement('div');
            bottomZone.className = 'lib-overlay-bottom';
            bottomZone.textContent = 'Context';
            bottomZone.addEventListener('click', async (e) => {
                e.stopPropagation();
                // Load into main view
                els.resultImage.src = img.src;
                els.resultImage.classList.remove('hidden');
                els.placeholder.classList.add('hidden');
                currentImagePath = file.path;
                els.downloadArea.classList.remove('hidden');
                
                // Restore context
                await restoreContext(file.path);
            });

            div.appendChild(img);
            div.appendChild(counterSpan);
            div.appendChild(topZone);
            div.appendChild(bottomZone);
            
            els.libraryList.appendChild(div);
        });

        // End Bar
        const endBar = document.createElement('div');
        endBar.style.height = '2px';
        endBar.style.backgroundColor = 'white';
        endBar.style.marginTop = '0px'; // Margin handled by previous element's bottom margin
        endBar.style.flexShrink = '0';
        els.libraryList.appendChild(endBar);

    } catch (e) {
        log(`Error loading library: ${e.message}`, 'error');
    }
}

async function addLibraryImageToReference(filePath) {
    if (state.references.length >= 9) {
        log('Reference limit reached (9).', 'warn');
        return;
    }
    
    try {
        const buffer = fs.readFileSync(filePath);
        const hash = crypto.createHash('md5').update(buffer).digest('hex');
        
        // Determine extension from file path or magic bytes? 
        // filePath is known to be .png or .jpg from list-output-files
        let ext = path.extname(filePath).substring(1);
        
        const saveName = `${hash}.${ext}`;
        const savePath = path.join(INPUT_DIR, saveName);
        
        if (!fs.existsSync(savePath)) {
            fs.writeFileSync(savePath, buffer);
            log(`Saved to references: ${saveName}`);
        }
        
        // Avoid dupes in state
        if (state.references.some(r => r.hash === hash)) {
            log('Image already in references.', 'warn');
            return;
        }

        // Detect mime for state
        // Simple inference based on ext since we trust our own output
        const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';

        state.references.push({
            hash,
            mimeType,
            data: buffer.toString('base64')
        });
        
        updateStateUI();
        log('Added to references.', 'success');

    } catch (err) {
        log(`Failed to add reference: ${err.message}`, 'error');
    }
}

// --- Init Sequence ---
// Call after paths are ready
const initApp = async () => {
    await loadLibrary();
};
// Trigger init when input dir is ready
// (Modified the top-level async IIFE to call this)

// --- Interaction ---

// Reset
els.resetBtn.addEventListener('click', () => {
    state = {
        resolution: '1K',
        aspectRatio: '1:1',
        references: [],
        prompt: ''
    };
    
    // Clear UI specific elements
    els.resultImage.src = '';
    els.resultImage.classList.add('hidden');
    els.placeholder.classList.remove('hidden');
    els.downloadArea.classList.add('hidden');
    els.tag.classList.add('hidden');
    currentImagePath = null;
    
    updateStateUI();
    log('Context reset.');
});

// Helper to get path safely
function getFilePath(file) {
    if (file.path) return file.path;
    if (webUtils && webUtils.getPathForFile) return webUtils.getPathForFile(file);
    return null;
}

// Button Groups
els.resGroup.addEventListener('click', e => {
  if (e.target.tagName === 'BUTTON') {
    state.resolution = e.target.dataset.value;
    updateStateUI();
  }
});

els.ratioGroup.addEventListener('click', e => {
  if (e.target.tagName === 'BUTTON') {
    state.aspectRatio = e.target.dataset.value;
    updateStateUI();
  }
});

// Prompt
els.prompt.addEventListener('input', () => {
  state.prompt = els.prompt.value;
  els.charCounter.textContent = els.prompt.value.length;
});

// Reference Images Drag & Drop
els.refDrop.addEventListener('click', () => els.refInput.click());
els.refInput.addEventListener('change', e => handleRefFiles(e.target.files));

els.refDrop.addEventListener('dragover', e => {
  e.preventDefault();
  els.refDrop.classList.add('drag-over');
});
els.refDrop.addEventListener('dragleave', () => els.refDrop.classList.remove('drag-over'));
els.refDrop.addEventListener('drop', e => {
  e.preventDefault();
  els.refDrop.classList.remove('drag-over');
  handleRefFiles(e.dataTransfer.files);
});

async function handleRefFiles(files) {
  if (!INPUT_DIR) {
      log('System initializing, please wait...', 'error');
      return;
  }

  for (const file of files) {
    if (state.references.length >= 9) break;
    if (!file.type.startsWith('image/')) continue;

    const filePath = getFilePath(file);
    if (!filePath) {
        log(`Could not determine path for file: ${file.name}`, 'error');
        continue;
    }

    try {
      const buffer = fs.readFileSync(filePath);
      
      // Calculate MD5
      const hash = crypto.createHash('md5').update(buffer).digest('hex');
      
      // Determine extension
      // Use original extension if possible, or infer from mime
      let ext = path.extname(file.name).substring(1); 
      if (!ext) ext = 'png'; // fallback
      
      const saveName = `${hash}.${ext}`;
      const savePath = path.join(INPUT_DIR, saveName);
      
      if (!fs.existsSync(savePath)) {
          fs.writeFileSync(savePath, buffer);
          log(`Saved: ${saveName}`);
      } else {
          log(`Exists: ${saveName}`);
      }
      
      // Check if already in list to avoid visual duplicates? 
      // Requirement doesn't specify, but good UX.
      if (state.references.some(r => r.hash === hash)) {
          log(`Image already added to references.`);
          continue;
      }

      const base64 = buffer.toString('base64');
      state.references.push({
        hash,
        mimeType: file.type,
        data: base64
      });
      
    } catch (err) {
      log(`Error reading ${file.name}: ${err.message}`, 'error');
    }
  }
  updateStateUI();
}

// Restore Context Drag & Drop
els.restoreDrop.addEventListener('dragover', e => {
  e.preventDefault();
  els.restoreDrop.classList.add('drag-over');
});
els.restoreDrop.addEventListener('dragleave', () => els.restoreDrop.classList.remove('drag-over'));
els.restoreDrop.addEventListener('drop', async e => {
  e.preventDefault();
  els.restoreDrop.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) {
      const filePath = getFilePath(file);
      if (filePath) await restoreContext(filePath);
      else log('Could not determine path for restored file.', 'error');
  }
});

async function restoreContext(filePath) {
  log(`Restoring context from ${path.basename(filePath)}...`);
  try {
    const buffer = fs.readFileSync(filePath);
    let metadataStr = null;

    // Try PNG tEXt
    if (filePath.toLowerCase().endsWith('.png')) {
        const pngMeta = readPngMetadata(buffer);
        if (pngMeta) metadataStr = pngMeta;
    }
    
    // Try JPEG UserComment
    if (!metadataStr && (filePath.toLowerCase().match(/\.jpe?g$/))) {
         const jpgData = buffer.toString('binary');
         const exifObj = piexif.load(jpgData);
         if (exifObj && exifObj.Exif && exifObj.Exif[piexif.ExifIFD.UserComment]) {
             const comment = exifObj.Exif[piexif.ExifIFD.UserComment];
             if (comment.startsWith("BananaAppMeta:")) {
                 metadataStr = comment.replace("BananaAppMeta:", "");
             }
         }
    }

    if (metadataStr) {
      const jsonStr = Buffer.from(metadataStr, 'base64').toString('utf8');
      const data = JSON.parse(jsonStr);
      
      state.resolution = data.resolution || '1K';
      state.aspectRatio = data.ratio || '1:1';
      els.prompt.value = data.prompt || '';
      
      // Restore References
      state.references = [];
      if (data.referenceImages && Array.isArray(data.referenceImages)) {
          // data.referenceImages is [{hash, mimeType}]
          const files = fs.readdirSync(INPUT_DIR);
          
          for (const ref of data.referenceImages) {
              // Find file starting with hash
              const match = files.find(f => f.startsWith(ref.hash));
              if (match) {
                  const refPath = path.join(INPUT_DIR, match);
                  const refBuffer = fs.readFileSync(refPath);
                  state.references.push({
                      hash: ref.hash,
                      mimeType: ref.mimeType,
                      data: refBuffer.toString('base64')
                  });
              } else {
                  log(`Reference not found: ${ref.hash}`, 'warn');
              }
          }
      }
      
      updateStateUI();
      els.charCounter.textContent = els.prompt.value.length;
      
      log('Context restored successfully!', 'success');
    } else {
      log('No compatible metadata found.', 'error');
    }
  } catch (err) {
    log(`Restore failed: ${err.message}`, 'error');
  }
}

function readPngMetadata(buffer) {
    let offset = 8; 
    while (offset < buffer.length) {
        const len = buffer.readUInt32BE(offset);
        const type = buffer.slice(offset + 4, offset + 8).toString();
        
        if (type === 'tEXt') {
            const dataStart = offset + 8;
            const dataEnd = dataStart + len;
            const data = buffer.slice(dataStart, dataEnd);
            
            const nullIdx = data.indexOf(0);
            if (nullIdx > -1) {
                const key = data.slice(0, nullIdx).toString('latin1');
                const val = data.slice(nullIdx + 1).toString('latin1');
                
                if (key === 'BananaAppMeta') {
                    return val;
                }
            }
        }
        
        offset += 12 + len;
    }
    return null;
}

// Generate
let currentImagePath = null;

els.generateBtn.addEventListener('click', async () => {
  const prompt = els.prompt.value.trim();
  if (!prompt) {
    log('Please enter a prompt.', 'error');
    return;
  }

  els.generateBtn.disabled = true;
  els.spinner.classList.remove('hidden');
  els.resultImage.classList.add('hidden');
  els.placeholder.classList.add('hidden');
  els.downloadArea.classList.add('hidden'); // Hide download while regenerating
  
  log(`Generating... [${state.resolution}, ${state.aspectRatio}]`);

  const requestData = {
    prompt,
    resolution: state.resolution,
    ratio: state.aspectRatio,
    // Send only hash and mimeType
    referenceImages: state.references.map(r => ({ hash: r.hash, mimeType: r.mimeType }))
  };

  try {
    const result = await ipcRenderer.invoke('generate-image', requestData);
    
    if (result.success) {
      log(`Image generated: ${result.path}`, 'success');
      els.resultImage.src = `file://${result.path}`;
      els.resultImage.classList.remove('hidden');
      els.tag.textContent = `${state.resolution} • ${state.aspectRatio}`;
      els.tag.classList.remove('hidden');
      
      currentImagePath = result.path;
      els.downloadArea.classList.remove('hidden');
      
      // Refresh Library
      await loadLibrary();
      
    } else {
      log(`Error: ${result.error}`, 'error');
      els.placeholder.classList.remove('hidden');
    }
  } catch (err) {
    log(`IPC Error: ${err.message}`, 'error');
    els.placeholder.classList.remove('hidden');
  } finally {
    els.generateBtn.disabled = false;
    els.spinner.classList.add('hidden');
  }
});

els.downloadBtn.addEventListener('click', async () => {
    if (!currentImagePath) return;
    const res = await ipcRenderer.invoke('download-image', currentImagePath);
    if (res.success) {
        log(`Saved copy to: ${res.path}`, 'success');
    } else if (res.error) {
        log(`Save failed: ${res.error}`, 'error');
    } else if (res.canceled) {
        log('Save canceled.');
    }
});

// --- Title Bar Controls ---
document.getElementById('btn-minimize').addEventListener('click', () => {
    ipcRenderer.invoke('window-minimize');
});

document.getElementById('btn-maximize').addEventListener('click', () => {
    ipcRenderer.invoke('window-maximize');
});

document.getElementById('btn-close').addEventListener('click', () => {
    ipcRenderer.invoke('window-close');
});