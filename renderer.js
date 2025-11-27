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
  references: [], // { hash, mimeType, data (base64) }
  requests: [], // { id, status, prompt, resolution, ratio, references, timestamp, resultPath, error }
  currentRequestId: null
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
        await loadInputLibrary();
        await loadOutputLibrary();
        
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
  requestList: document.getElementById('request-list'), // New
  
  previewArea: document.getElementById('image-preview-container'),
  placeholder: document.getElementById('placeholder-state'),
  resultImage: document.getElementById('result-image'),
  spinner: document.getElementById('loading-spinner'),
  tag: document.getElementById('preview-tag'),
  
  downloadArea: document.getElementById('download-area'),
  downloadBtn: document.getElementById('download-btn'),
  
  resetBtn: document.getElementById('reset-btn'),
  
  libraryListInput: document.getElementById('library-list-input'),
  libraryCountInput: document.getElementById('library-count-input'),
  
  libraryListOutput: document.getElementById('library-list-output'),
  libraryCountOutput: document.getElementById('library-count-output'),
  
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

// --- Request List Rendering ---
function renderRequestList() {
    els.requestList.innerHTML = '';
    
    state.requests.forEach(req => {
        const item = document.createElement('div');
        item.className = `request-item ${state.currentRequestId === req.id ? 'active' : ''}`;
        
        // Icon based on status
        const iconDiv = document.createElement('div');
        iconDiv.className = 'request-status-icon';
        
        if (req.status === 'pending') {
            const spinner = document.createElement('div');
            spinner.className = 'spinner-small';
            iconDiv.appendChild(spinner);
        } else if (req.status === 'success') {
            iconDiv.textContent = '✓';
            iconDiv.classList.add('status-success');
        } else {
            iconDiv.textContent = '✕';
            iconDiv.classList.add('status-error');
        }
        
        // Info
        const infoDiv = document.createElement('div');
        infoDiv.className = 'request-info';
        
        const promptEl = document.createElement('div');
        promptEl.className = 'request-prompt';
        promptEl.textContent = req.prompt || '(No prompt)';
        
        const metaEl = document.createElement('div');
        metaEl.className = 'request-meta';
        metaEl.textContent = `${req.resolution} • ${req.ratio} • ${new Date(req.timestamp).toLocaleTimeString()}`;
        
        infoDiv.appendChild(promptEl);
        infoDiv.appendChild(metaEl);
        
        item.appendChild(iconDiv);
        item.appendChild(infoDiv);
        
        item.addEventListener('click', () => selectRequest(req.id));
        
        els.requestList.appendChild(item);
    });
}

function selectRequest(id) {
    const req = state.requests.find(r => r.id === id);
    if (!req) return;
    
    state.currentRequestId = id;
    renderRequestList(); // update active class
    
    // Restore Context
    state.resolution = req.resolution;
    state.aspectRatio = req.ratio;
    state.prompt = req.prompt;
    // Deep copy references to avoid mutation issues
    state.references = JSON.parse(JSON.stringify(req.references));
    
    updateStateUI();
    
    // Update Main View
    updateMainView(req);
}

function updateMainView(req) {
    // Hide everything first
    els.resultImage.classList.add('hidden');
    els.placeholder.classList.add('hidden');
    els.spinner.classList.add('hidden');
    els.tag.classList.add('hidden');
    els.downloadArea.classList.add('hidden');
    els.resultImage.src = '';
    
    if (req.status === 'pending') {
        els.spinner.classList.remove('hidden');
        els.tag.textContent = `${req.resolution} • ${req.ratio}`;
        els.tag.classList.remove('hidden');
    } else if (req.status === 'success') {
        els.resultImage.src = `file://${req.resultPath}`;
        els.resultImage.classList.remove('hidden');
        els.tag.textContent = `${req.resolution} • ${req.ratio}`;
        els.tag.classList.remove('hidden');
        els.downloadArea.classList.remove('hidden');
    } else if (req.status === 'error') {
        els.placeholder.classList.remove('hidden');
        // Show error in placeholder?
        const icon = els.placeholder.querySelector('.placeholder-icon');
        if (icon) icon.textContent = '⚠️'; // warning icon
        // We removed text from placeholder as per requirements, but maybe we should show error toast?
        // Or just rely on logs.
        // "in case of failed request show error info in box for generated images."
        // Since we removed text, we should probably add a temporary error message element.
        let errEl = els.placeholder.querySelector('.error-msg');
        if (!errEl) {
             errEl = document.createElement('p');
             errEl.className = 'error-msg';
             errEl.style.color = '#f44336';
             errEl.style.marginTop = '10px';
             els.placeholder.appendChild(errEl);
        }
        errEl.textContent = req.error || 'Generation failed';
        els.placeholder.classList.remove('hidden');
    }
}

// --- Library Management ---
async function loadOutputLibrary() {
    try {
        const files = await ipcRenderer.invoke('list-output-files');
        els.libraryListOutput.innerHTML = '';
        if (els.libraryCountOutput) els.libraryCountOutput.textContent = files.length;
        
        const startBar = document.createElement('div');
        startBar.style.height = '2px';
        startBar.style.backgroundColor = 'white';
        startBar.style.marginBottom = '10px';
        startBar.style.flexShrink = '0'; 
        els.libraryListOutput.appendChild(startBar);

        files.forEach((file, idx) => {
            const div = document.createElement('div');
            div.className = 'library-item';
            div.title = `Generated: ${new Date(file.mtime).toLocaleString()}`;
            
            const img = document.createElement('img');
            img.src = `file://${file.path}`; 
            img.className = 'library-thumb';
            img.loading = 'lazy';

            const counterSpan = document.createElement('span');
            counterSpan.className = 'library-item-counter';
            counterSpan.textContent = idx + 1;
            
            const topZone = document.createElement('div');
            topZone.className = 'lib-overlay-top';
            topZone.textContent = 'Reference';
            topZone.addEventListener('click', async (e) => {
                e.stopPropagation();
                await addLibraryImageToReference(file.path);
            });
            
            const bottomZone = document.createElement('div');
            bottomZone.className = 'lib-overlay-bottom';
            bottomZone.textContent = 'Context';
            bottomZone.addEventListener('click', async (e) => {
                e.stopPropagation();
                // Load into main view by simulating a request or just restoring
                // We don't have a "request" object for library items unless we create one.
                // But clicking context works as "restore context"
                await restoreContext(file.path);
                
                // Also show the image
                els.resultImage.src = img.src;
                els.resultImage.classList.remove('hidden');
                els.placeholder.classList.add('hidden');
                els.downloadArea.classList.remove('hidden');
                // Update tag
                // We can read meta or just use what we have
                els.tag.textContent = `${state.resolution} • ${state.aspectRatio}`; // state updated by restoreContext
                els.tag.classList.remove('hidden');
            });

            div.appendChild(img);
            div.appendChild(counterSpan);
            div.appendChild(topZone);
            div.appendChild(bottomZone);
            
            els.libraryListOutput.appendChild(div);
        });

        const endBar = document.createElement('div');
        endBar.style.height = '2px';
        endBar.style.backgroundColor = 'white';
        endBar.style.marginTop = '0px';
        endBar.style.flexShrink = '0';
        els.libraryListOutput.appendChild(endBar);

    } catch (e) {
        log(`Error loading output library: ${e.message}`, 'error');
    }
}

async function loadInputLibrary() {
    try {
        const files = await ipcRenderer.invoke('list-input-files');
        els.libraryListInput.innerHTML = '';
        if (els.libraryCountInput) els.libraryCountInput.textContent = files.length;
        
        const startBar = document.createElement('div');
        startBar.style.height = '2px';
        startBar.style.backgroundColor = 'white';
        startBar.style.marginBottom = '10px';
        startBar.style.flexShrink = '0'; 
        els.libraryListInput.appendChild(startBar);

        files.forEach((file, idx) => {
            const div = document.createElement('div');
            div.className = 'library-item';
            div.title = `Input Image: ${file.name}`;
            
            const img = document.createElement('img');
            img.src = `file://${file.path}`;
            img.className = 'library-thumb';
            img.loading = 'lazy';

            const counterSpan = document.createElement('span');
            counterSpan.className = 'library-item-counter';
            counterSpan.textContent = idx + 1; 
            
            const overlay = document.createElement('div');
            overlay.className = 'lib-overlay-single';
            
            overlay.addEventListener('click', async (e) => {
                e.stopPropagation();
                await addLibraryImageToReference(file.path);
            });

            div.appendChild(img);
            div.appendChild(counterSpan);
            div.appendChild(overlay);
            
            els.libraryListInput.appendChild(div);
        });

        const endBar = document.createElement('div');
        endBar.style.height = '2px';
        endBar.style.backgroundColor = 'white';
        endBar.style.marginTop = '0px';
        endBar.style.flexShrink = '0';
        els.libraryListInput.appendChild(endBar);

    } catch (e) {
        log(`Error loading input library: ${e.message}`, 'error');
    }
}

async function addLibraryImageToReference(filePath) {
    try {
        const buffer = fs.readFileSync(filePath);
        const hash = crypto.createHash('md5').update(buffer).digest('hex');
        
        const existingIdx = state.references.findIndex(r => r.hash === hash);
        if (existingIdx !== -1) {
            removeRef(existingIdx);
            log('Removed from references.', 'info');
            return;
        }

        if (state.references.length >= 9) {
            log('Reference limit reached (9).', 'warn');
            return;
        }

        let ext = path.extname(filePath).substring(1);
        
        const saveName = `${hash}.${ext}`;
        const savePath = path.join(INPUT_DIR, saveName);
        
        if (!fs.existsSync(savePath)) {
            fs.writeFileSync(savePath, buffer);
            log(`Saved to references: ${saveName}`);
        }
        
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

// --- Interaction ---

els.resetBtn.addEventListener('click', () => {
    state.resolution = '1K';
    state.aspectRatio = '1:1';
    state.references = [];
    state.prompt = '';
    
    // We do not clear the request list, just the context form
    state.currentRequestId = null;
    
    els.resultImage.src = '';
    els.resultImage.classList.add('hidden');
    els.placeholder.classList.remove('hidden');
    els.downloadArea.classList.add('hidden');
    els.tag.classList.add('hidden');
    
    // Clear error msg if any
    const errEl = els.placeholder.querySelector('.error-msg');
    if (errEl) errEl.remove();
    const icon = els.placeholder.querySelector('.placeholder-icon');
    if (icon) icon.textContent = '🖼️';
    
    updateStateUI();
    renderRequestList(); // to remove active selection
    log('Context reset.');
});

function getFilePath(file) {
    if (file.path) return file.path;
    if (webUtils && webUtils.getPathForFile) return webUtils.getPathForFile(file);
    return null;
}

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
      const hash = crypto.createHash('md5').update(buffer).digest('hex');
      let ext = path.extname(file.name).substring(1); 
      if (!ext) ext = 'png'; 
      
      const saveName = `${hash}.${ext}`;
      const savePath = path.join(INPUT_DIR, saveName);
      
      if (!fs.existsSync(savePath)) {
          fs.writeFileSync(savePath, buffer);
          log(`Saved: ${saveName}`);
      }
      
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
  await loadInputLibrary();
}

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

    if (filePath.toLowerCase().endsWith('.png')) {
        const pngMeta = readPngMetadata(buffer);
        if (pngMeta) metadataStr = pngMeta;
    }
    
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
      state.prompt = data.prompt || '';
      els.prompt.value = state.prompt;
      
      state.references = [];
      if (data.referenceImages && Array.isArray(data.referenceImages)) {
          const files = fs.readdirSync(INPUT_DIR);
          
          for (const ref of data.referenceImages) {
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

// --- Generate Logic (Parallel) ---
els.generateBtn.addEventListener('click', () => {
  const prompt = els.prompt.value.trim();
  if (!prompt) {
    log('Please enter a prompt.', 'error');
    return;
  }

  // Create Request Object
  const reqId = Date.now();
  const reqObj = {
      id: reqId,
      status: 'pending',
      prompt: state.prompt,
      resolution: state.resolution,
      ratio: state.aspectRatio,
      // Deep copy refs
      references: JSON.parse(JSON.stringify(state.references)),
      timestamp: new Date(),
      resultPath: null,
      error: null
  };

  // Add to start of list
  state.requests.unshift(reqObj);
  
  // Select it
  state.currentRequestId = reqId;
  
  renderRequestList();
  updateMainView(reqObj);
  
  log(`Queued request: ${reqId}`);

  const requestData = {
    prompt: reqObj.prompt,
    resolution: reqObj.resolution,
    ratio: reqObj.ratio,
    referenceImages: reqObj.references.map(r => ({ hash: r.hash, mimeType: r.mimeType }))
  };

  // Call IPC without await blocking the function
  ipcRenderer.invoke('generate-image', requestData)
    .then(result => {
        const r = state.requests.find(x => x.id === reqId);
        if (!r) return; // Should not happen

        if (result.success) {
            r.status = 'success';
            r.resultPath = result.path;
            log(`Request ${reqId} completed.`, 'success');
            loadOutputLibrary(); // Refresh library
        } else {
            r.status = 'error';
            r.error = result.error;
            log(`Request ${reqId} failed: ${result.error}`, 'error');
        }
        
        renderRequestList();
        // Update main view if this request is still selected
        if (state.currentRequestId === reqId) {
            updateMainView(r);
        }
    })
    .catch(err => {
        const r = state.requests.find(x => x.id === reqId);
        if (!r) return;
        
        r.status = 'error';
        r.error = err.message;
        log(`Request ${reqId} crashed: ${err.message}`, 'error');
        
        renderRequestList();
        if (state.currentRequestId === reqId) {
            updateMainView(r);
        }
    });
});

els.downloadBtn.addEventListener('click', async () => {
    // Find current request path or just use result-image src?
    // We should use the current request's result path if available
    const req = state.requests.find(r => r.id === state.currentRequestId);
    const path = req ? req.resultPath : null;
    
    if (!path) return;
    
    const res = await ipcRenderer.invoke('download-image', path);
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
