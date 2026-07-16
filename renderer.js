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
  quality: null,
  imageProvider: 'ai_studio_nano_banana_pro',
  /** When set, metadata used this model but user kept a different current model */
  contextSourceProviderId: null,
  availableProviders: [],
  prompt: '',
  references: [], // { hash, mimeType, data (base64) }
  requests: [], // { id, status, prompt, resolution, ratio, references, timestamp, resultPath, error, kieTaskId? }
  currentRequestId: null,
  activeProject: null, // { title, imageName, imagePath }
  
  // Conveyor State
  conveyorQueue: [],
  activeConveyor: null, // { id, prompt, generalRefs, conveyorRefs, currentIdx, total }
  isConveyorRunning: false,
  conveyorSelectionTarget: 'conveyor', // 'general' or 'conveyor'
  conveyorDraft: {
      prompt: '',
      resolution: '1K',
      aspectRatio: '1:1',
      generalRefs: [], // Array of file paths or objects
      conveyorRefs: [] // Array of file paths or objects
  }
};

let INPUT_DIR = null;
let OUTPUT_DIR = null; // Track this too

// --- Init ---
(async () => {
    try {
        await updatePaths();
        
        // Load settings
        const settings = await ipcRenderer.invoke('get-settings');
        if (settings.resolution) state.resolution = settings.resolution;
        if (settings.aspectRatio) state.aspectRatio = settings.aspectRatio;
        if (settings.quality === 'basic' || settings.quality === 'high') state.quality = settings.quality;
        if (settings.imageProvider) state.imageProvider = settings.imageProvider;
        state.availableProviders = settings.availableProviders || [];
        
        // Initial library load
        await loadProjectsLibrary(); // New
        await loadInputLibrary();
        await loadOutputLibrary();
        
        populateMainModelSelect();
        updateStateUI();

        // Init Conveyor UI
        updateConveyorStatusUI();
        setupConveyorUI(); // New init function
        setupAutoResize();
        autoResizeTextarea(els.prompt); // Initial resize for main prompt
        
    } catch (e) {
        log(`Error initializing paths: ${e.message}`, 'error');
    }
})();

async function updatePaths() {
    const paths = await ipcRenderer.invoke('get-project-details', state.activeProject ? state.activeProject.title : null);
    INPUT_DIR = paths.input;
    OUTPUT_DIR = paths.output;
    
    // Ensure dirs exist (renderer shouldn't strictly do this but good for safety if we write directly)
    if (!fs.existsSync(INPUT_DIR)) fs.mkdirSync(INPUT_DIR, { recursive: true });
}

// Listen for debug logs from main process
ipcRenderer.on('debug-log', async (event, ...args) => {
    const settings = await ipcRenderer.invoke('get-settings');
    if (settings.debugMode) {
        console.log('[Main Process]:', ...args);
    }
});

// --- DOM Elements ---
const els = {
  refDrop: document.getElementById('ref-drop-zone'),
  refInput: document.getElementById('ref-file-input'),
  refList: document.getElementById('ref-list'),
  refEmpty: document.getElementById('ref-empty-state'),
  refCount: document.getElementById('ref-count'),
  
  resGroup: document.getElementById('resolution-group'),
  ratioGroup: document.getElementById('ratio-group'),
  qualityGroup: document.getElementById('quality-group'),
  resolutionControl: document.getElementById('resolution-control'),
  ratioControl: document.getElementById('ratio-control'),
  qualityControl: document.getElementById('quality-control'),
  
  prompt: document.getElementById('prompt-input'),
  charCounter: document.getElementById('char-counter'),
  
  restoreDrop: document.getElementById('restore-drop-zone'),
  
  generateBtn: document.getElementById('generate-btn'),
  requestList: document.getElementById('request-list'),
  
  previewArea: document.getElementById('image-preview-container'),
  placeholder: document.getElementById('placeholder-state'),
  resultImage: document.getElementById('result-image'),
  spinner: document.getElementById('loading-spinner'),
  tag: document.getElementById('preview-tag'),
  mainProviderSelect: document.getElementById('main-provider-select'),
  contextModelMismatch: document.getElementById('context-model-mismatch'),
  contextModelUsedLabel: document.getElementById('context-model-used-label'),
  btnSwitchContextModel: document.getElementById('btn-switch-context-model'),

  resetBtn: document.getElementById('reset-btn'),

  // Libraries
  libraryListProjects: document.getElementById('library-list-projects'),
  btnAddProject: document.getElementById('btn-add-project'),

  libraryListInput: document.getElementById('library-list-input'),
  libraryCountInput: document.getElementById('library-count-input'),
  inputLibraryHeader: document.getElementById('input-library-header'),
  btnOpenInputFolder: document.getElementById('btn-open-input-folder'),
  
  libraryListOutput: document.getElementById('library-list-output'),
  libraryCountOutput: document.getElementById('library-count-output'),
  outputLibraryHeader: document.getElementById('output-library-header'),
  btnOpenOutputFolder: document.getElementById('btn-open-output-folder'),
  
  logs: document.getElementById('logs-output'),

  // Settings
  settingsOverlay: document.getElementById('settings-overlay'),
  btnSettings: document.getElementById('btn-settings'),
  btnCloseSettings: document.getElementById('btn-close-settings'),
  btnSaveSettings: document.getElementById('btn-save-settings'),
  settingsTabKeys: document.getElementById('settings-tab-keys'),
  settingsTabLimits: document.getElementById('settings-tab-limits'),
  settingsTabApp: document.getElementById('settings-tab-app'),
  settingsPanelKeys: document.getElementById('settings-panel-keys'),
  settingsPanelLimits: document.getElementById('settings-panel-limits'),
  settingsPanelApp: document.getElementById('settings-panel-app'),
  vendorLimitsContainer: document.getElementById('vendor-limits-container'),
  apiKeyInput: document.getElementById('api-key-input'),
  kieApiKeyInput: document.getElementById('kie-api-key-input'),
  debugCheckbox: document.getElementById('debug-mode-checkbox'),

  // Project Overlay
  projectOverlay: document.getElementById('project-overlay'),
  btnCloseProject: document.getElementById('btn-close-project'),
  btnSaveProject: document.getElementById('btn-save-project'),
  projectTitleInput: document.getElementById('project-title-input'),
  projectPreviewImg: document.getElementById('project-new-preview-img'),
  projectPreviewPlaceholder: document.getElementById('project-new-preview-placeholder'),
  projectImageGrid: document.getElementById('project-image-grid'),

  hoverPreview: document.getElementById('hover-preview'),
  hoverPreviewImg: document.getElementById('hover-preview-img'),

  // Conveyor Elements
  conveyorStatusBox: document.getElementById('conveyor-status-box'),
  conveyorPromptPreview: document.getElementById('conveyor-prompt-preview'),
  conveyorCounter: document.getElementById('conveyor-counter'),
  btnStopConveyor: document.getElementById('btn-stop-conveyor'),
  btnAddConveyor: document.getElementById('btn-add-conveyor'),
  
  conveyorOverlay: document.getElementById('conveyor-overlay'),
  btnCloseConveyor: document.getElementById('btn-close-conveyor'),
  conveyorLibraryGrid: document.getElementById('conveyor-library-grid'),
  
  conveyorResGroup: document.getElementById('conveyor-resolution-group'),
  conveyorRatioGroup: document.getElementById('conveyor-ratio-group'),
  
  conveyorPromptInput: document.getElementById('conveyor-prompt-input'),
  
  groupGenRefs: document.getElementById('group-gen-refs'),
  conveyorGenRefList: document.getElementById('conveyor-gen-ref-list'),
  conveyorGenRefCount: document.getElementById('conveyor-gen-ref-count'),
  
  groupConvRefs: document.getElementById('group-conv-refs'),
  conveyorImgList: document.getElementById('conveyor-img-list'),
  conveyorImgCount: document.getElementById('conveyor-img-count'),
  
  btnExecuteConveyor: document.getElementById('btn-execute-conveyor'),

  conveyorDetailsOverlay: document.getElementById('conveyor-details-overlay'),
  detailsPrompt: document.getElementById('details-prompt'),
  detailsGenRefs: document.getElementById('details-gen-refs'),
  detailsConvList: document.getElementById('details-conv-list'),

  conveyorQueueOverlay: document.getElementById('conveyor-queue-overlay'),
  conveyorQueueList: document.getElementById('conveyor-queue-list')
};

const KEY_PLACEHOLDER_MASK = '**********';

const VENDOR_LABELS = {
  kie_ai: 'Kie.ai',
  ai_studio: 'Google AI Studio'
};

let syncingMainModelSelect = false;

function showSettingsTab(tabId) {
  const tabs = [
    { id: 'keys', tab: els.settingsTabKeys, panel: els.settingsPanelKeys },
    { id: 'limits', tab: els.settingsTabLimits, panel: els.settingsPanelLimits },
    { id: 'app', tab: els.settingsTabApp, panel: els.settingsPanelApp }
  ];
  for (const { id, tab, panel } of tabs) {
    if (!tab || !panel) continue;
    const on = id === tabId;
    tab.classList.toggle('active', on);
    panel.classList.toggle('hidden', !on);
  }
}

function appendVendorLimitField(section, vendor, field, label, value) {
  const wrap = document.createElement('div');
  wrap.className = 'setting-item';
  const lab = document.createElement('label');
  lab.htmlFor = `lim-${vendor}-${field}`;
  lab.textContent = label;
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.id = `lim-${vendor}-${field}`;
  inp.dataset.vendor = vendor;
  inp.dataset.limitField = field;
  inp.value = String(value);
  wrap.appendChild(lab);
  wrap.appendChild(inp);
  section.appendChild(wrap);
}

function renderVendorLimitsPanel(limits) {
  if (!els.vendorLimitsContainer) return;
  els.vendorLimitsContainer.innerHTML = '';
  const vendors = Object.keys(limits || {}).sort();
  for (const vendor of vendors) {
    const row = limits[vendor];
    if (!row) continue;
    const section = document.createElement('div');
    section.className = 'vendor-limit-section';
    const h = document.createElement('h4');
    h.textContent = VENDOR_LABELS[vendor] || vendor;
    section.appendChild(h);
    appendVendorLimitField(section, vendor, 'maxConcurrent', 'Макс. параллельных задач', row.maxConcurrent);
    appendVendorLimitField(
      section,
      vendor,
      'maxStartsPerWindow',
      'Макс. запусков за окно',
      row.maxStartsPerWindow
    );
    const windowSec = Math.round((row.windowMs || 10000) / 1000);
    appendVendorLimitField(section, vendor, 'windowSec', 'Окно (секунды)', windowSec);
    appendVendorLimitField(
      section,
      vendor,
      'pollIntervalMs',
      'Интервал опроса (мс)',
      row.pollIntervalMs
    );
    const pollHint = document.createElement('p');
    pollHint.className = 'settings-hint';
    pollHint.style.marginTop = '8px';
    pollHint.textContent =
      vendor === 'kie_ai'
        ? 'Интервал опроса применяется для проверки статуса задач Kie.'
        : 'Интервал опроса зарезервирован для будущих асинхронных задач этого провайдера.';
    section.appendChild(pollHint);
    els.vendorLimitsContainer.appendChild(section);
  }
}

function collectVendorJobLimitsFromForm() {
  const out = {};
  if (!els.vendorLimitsContainer) return out;
  const inputs = els.vendorLimitsContainer.querySelectorAll('input[data-vendor][data-limit-field]');
  inputs.forEach((inp) => {
    const v = inp.dataset.vendor;
    const f = inp.dataset.limitField;
    if (!v || !f) return;
    if (!out[v]) out[v] = {};
    const n = Number(inp.value);
    out[v][f] = Number.isFinite(n) ? n : 0;
  });
  for (const v of Object.keys(out)) {
    const r = out[v];
    if (r.windowSec != null) {
      r.windowMs = Math.max(1000, Math.round(r.windowSec * 1000));
      delete r.windowSec;
    }
  }
  return out;
}

// --- Projects Logic ---
let newProjectSelectedImage = null; // path

async function loadProjectsLibrary() {
    try {
        const projects = await ipcRenderer.invoke('list-projects');
        els.libraryListProjects.innerHTML = '';
        
        // Add "All Projects" / "Root" item? 
        // Spec: "clicking on project in library switches content..."
        // Doesn't explicitly ask for a "Home" button, but users need a way to go back to root.
        // I will add a "Root / Default" item at the top.
        
        const rootDiv = document.createElement('div');
        rootDiv.className = `library-item ${state.activeProject === null ? 'active-project' : ''}`;
        rootDiv.innerHTML = `
            <div style="width:100%; height:100%; display:flex; justify-content:center; align-items:center; background:#222; color:#555; font-size:40px;">🏠</div>
            <div class="project-title-overlay">Основной</div>
        `;
        rootDiv.addEventListener('click', () => switchProject(null));
        els.libraryListProjects.appendChild(rootDiv);

        projects.forEach(proj => {
            const div = document.createElement('div');
            div.className = `library-item ${state.activeProject && state.activeProject.title === proj.title ? 'active-project' : ''}`;
            
            const img = document.createElement('img');
            img.src = `file://${proj.imagePath}`;
            img.className = 'library-thumb';
            img.loading = 'lazy';
            
            const titleOverlay = document.createElement('div');
            titleOverlay.className = 'project-title-overlay';
            titleOverlay.textContent = proj.title;
            
            div.appendChild(img);
            div.appendChild(titleOverlay);
            
            div.addEventListener('click', () => switchProject(proj));
            setupHoverPreview(div, () => img.src);
            
            els.libraryListProjects.appendChild(div);
        });

    } catch (e) {
        log(`Ошибка загрузки проектов: ${e.message}`, 'error');
    }
}

async function switchProject(project) {
    state.activeProject = project;
    
    // Update active class in UI
    const items = els.libraryListProjects.querySelectorAll('.library-item');
    items.forEach(item => {
        // Simple check based on text content or index? 
        // Ideally we track ID.
        item.classList.remove('active-project');
    });
    // Re-render to set active class properly (easier than finding the element)
    await loadProjectsLibrary();

    log(`Выбран проект: ${project ? project.title : 'Основной'}`);
    
    // Update Paths
    await updatePaths();
    
    // Refresh Libraries
    await loadInputLibrary();
    await loadOutputLibrary();
}

els.btnAddProject.addEventListener('click', async () => {
    // Open Modal
    els.projectTitleInput.value = '';
    els.projectPreviewImg.src = '';
    els.projectPreviewImg.classList.add('hidden');
    els.projectPreviewPlaceholder.classList.remove('hidden');
    newProjectSelectedImage = null;
    
    // Load images for grid
    await loadProjectCreationGrid();
    
    els.projectOverlay.classList.remove('hidden');
});

els.btnCloseProject.addEventListener('click', () => {
    els.projectOverlay.classList.add('hidden');
});

async function loadProjectCreationGrid() {
    els.projectImageGrid.innerHTML = '';
    // Use current input library images
    try {
        // We list inputs from the *current* context.
        // If user wants images from Root, they should switch to Root first?
        // Spec: "3.3 ... all images from input library".
        // I will interpret this as "currently visible inputs".
        const files = await ipcRenderer.invoke('list-input-files', state.activeProject ? state.activeProject.title : null);
        
        files.forEach(file => {
            const div = document.createElement('div');
            div.className = 'grid-item';
            
            const img = document.createElement('img');
            img.src = `file://${file.path}`;
            
            div.appendChild(img);
            
            div.addEventListener('click', () => {
                // Select
                els.projectImageGrid.querySelectorAll('.grid-item').forEach(d => d.classList.remove('selected'));
                div.classList.add('selected');
                
                // Update preview
                els.projectPreviewImg.src = img.src;
                els.projectPreviewImg.classList.remove('hidden');
                els.projectPreviewPlaceholder.classList.add('hidden');
                newProjectSelectedImage = file.path;
            });
            
            els.projectImageGrid.appendChild(div);
        });
    } catch (e) {
        log(`Ошибка загрузки списка: ${e.message}`, 'error');
    }
}

els.btnSaveProject.addEventListener('click', async () => {
    const title = els.projectTitleInput.value.trim();
    if (!title) {
        alert('Введите название проекта.');
        return;
    }
    if (!newProjectSelectedImage) {
        alert('Выберите изображение для превью.');
        return;
    }
    
    const result = await ipcRenderer.invoke('create-project', {
        title,
        sourceImagePath: newProjectSelectedImage
    });
    
    if (result.success) {
        log(`Проект «${title}» создан.`, 'success');
        els.projectOverlay.classList.add('hidden');
        await loadProjectsLibrary();
    } else {
        alert(`Не удалось создать проект: ${result.error}`);
    }
});


// --- Hover Preview Logic ---
function setupHoverPreview(element, getSrc) {
    element.addEventListener('mouseenter', () => {
        const src = getSrc();
        if (!src) return;
        
        els.hoverPreviewImg.src = src;
        els.hoverPreview.classList.remove('hidden');
        updateHoverPreviewPos(element);
    });

    element.addEventListener('mouseleave', () => {
        els.hoverPreview.classList.add('hidden');
        els.hoverPreviewImg.src = '';
    });
}

function updateHoverPreviewPos(element) {
    const rect = element.getBoundingClientRect();
    const offset = 10;
    
    // Default position: to the right of the element
    let x = rect.right + offset;
    let y = rect.top;

    // Check if the preview is ready to get its size
    const previewRect = els.hoverPreview.getBoundingClientRect();
    
    // If it goes off the right edge, place it to the left of the element
    if (x + previewRect.width > window.innerWidth) {
        x = rect.left - previewRect.width - offset;
    }
    
    // If it still goes off the left edge, center it horizontally
    if (x < 0) {
        x = (window.innerWidth - previewRect.width) / 2;
    }

    // Vertical boundary check
    if (y + previewRect.height > window.innerHeight) {
        y = window.innerHeight - previewRect.height - offset;
    }
    if (y < 0) y = offset;

    els.hoverPreview.style.left = `${x}px`;
    els.hoverPreview.style.top = `${y}px`;
}

function getProviderDisplayLabel(providerId) {
  if (!providerId) return '—';
  const p = state.availableProviders.find((x) => x.id === providerId);
  return p ? p.label : providerId;
}

function getProviderList() {
  return state.availableProviders.length
    ? state.availableProviders
    : [
        { id: 'ai_studio_nano_banana_pro', label: 'AI Studio — Nano Banana Pro' },
        { id: 'kie_nano_banana_pro', label: 'Kie.ai — Nano Banana Pro' }
      ];
}

function updateModelDisplayUICore() {
  if (els.contextModelMismatch && els.contextModelUsedLabel) {
    const show =
      Boolean(state.contextSourceProviderId) &&
      state.contextSourceProviderId !== state.imageProvider;
    els.contextModelMismatch.classList.toggle('hidden', !show);
    if (show) {
      els.contextModelUsedLabel.textContent = `Восстановленный контекст использовал: ${getProviderDisplayLabel(
        state.contextSourceProviderId
      )}`;
    }
  }
}

function populateMainModelSelect() {
  if (!els.mainProviderSelect) return;
  const list = getProviderList();
  els.mainProviderSelect.innerHTML = '';
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    els.mainProviderSelect.appendChild(opt);
  }
  const valid = list.some((p) => p.id === state.imageProvider);
  const nextVal = valid ? state.imageProvider : list[0].id;
  if (!valid) state.imageProvider = nextVal;
  syncingMainModelSelect = true;
  els.mainProviderSelect.value = nextVal;
  syncingMainModelSelect = false;
  if (state.contextSourceProviderId === state.imageProvider) {
    state.contextSourceProviderId = null;
  }
  updateModelDisplayUICore();
}

function updateModelDisplayUI() {
  if (els.mainProviderSelect && !syncingMainModelSelect) {
    const list = getProviderList();
    let want = state.imageProvider;
    if (!list.some((p) => p.id === want)) want = list[0].id;
    const opts = [...els.mainProviderSelect.options];
    const domOk = opts.length > 0 && opts.some((o) => o.value === want);
    if (!domOk) {
      populateMainModelSelect();
      return;
    }
    if (want !== state.imageProvider) state.imageProvider = want;
    if (els.mainProviderSelect.value !== want) {
      syncingMainModelSelect = true;
      els.mainProviderSelect.value = want;
      syncingMainModelSelect = false;
    }
  }
  updateModelDisplayUICore();
}

const FALLBACK_CAPABILITIES = {
  resolutions: ['1K', '2K', '4K'],
  qualities: [],
  ratios: ['1:1', '3:4', '4:3', '9:16', '16:9']
};

function getCurrentCapabilities() {
  const provider = getProviderList().find((p) => p.id === state.imageProvider);
  return provider?.capabilities || FALLBACK_CAPABILITIES;
}

function getAllowedResolutions(capabilities, ratio) {
  const mode = state.references.length ? 'edit' : 'text';
  return capabilities.resolutionRules?.[mode]?.[ratio] || capabilities.resolutions || [];
}

function renderOptionButtons(group, values, selected, labels = {}) {
  if (!group) return;
  group.innerHTML = '';
  for (const value of values) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'option-btn';
    button.dataset.value = value;
    button.textContent = labels[value] || value;
    button.classList.toggle('active', value === selected);
    group.appendChild(button);
  }
}

function syncGenerationControls() {
  const capabilities = getCurrentCapabilities();
  const ratios = capabilities.ratios?.length ? capabilities.ratios : FALLBACK_CAPABILITIES.ratios;
  if (!ratios.includes(state.aspectRatio)) state.aspectRatio = ratios[0];

  const resolutions = getAllowedResolutions(capabilities, state.aspectRatio);
  if (resolutions.length && !resolutions.includes(state.resolution)) state.resolution = resolutions[0];

  const qualities = capabilities.qualities || [];
  if (qualities.length && !qualities.includes(state.quality)) state.quality = qualities[0];
  if (!qualities.length) state.quality = null;

  els.resolutionControl?.classList.toggle('hidden', resolutions.length === 0);
  els.qualityControl?.classList.toggle('hidden', qualities.length === 0);
  els.ratioControl?.classList.toggle('hidden', ratios.length === 0);
  renderOptionButtons(els.resGroup, resolutions, state.resolution);
  renderOptionButtons(els.ratioGroup, ratios, state.aspectRatio);
  renderOptionButtons(els.qualityGroup, qualities, state.quality, { basic: 'Basic · 1K', high: 'High · 2K' });
}

// --- Settings Logic ---
async function openSettings() {
    const settings = await ipcRenderer.invoke('get-settings');
    els.debugCheckbox.checked = settings.debugMode;
    if (settings.availableProviders) state.availableProviders = settings.availableProviders;
    populateMainModelSelect();
    els.apiKeyInput.value = '';
    els.apiKeyInput.placeholder = settings.hasGeminiApiKey ? KEY_PLACEHOLDER_MASK : '';
    if (els.kieApiKeyInput) {
      els.kieApiKeyInput.value = '';
      els.kieApiKeyInput.placeholder = settings.hasKieApiKey ? KEY_PLACEHOLDER_MASK : '';
    }
    renderVendorLimitsPanel(settings.vendorJobLimits || {});
    showSettingsTab('keys');
    els.settingsOverlay.classList.remove('hidden');
}

function closeSettings() {
    els.settingsOverlay.classList.add('hidden');
}

async function saveSettings() {
    const apiKey = els.apiKeyInput.value;
    const kieApiKey = els.kieApiKeyInput ? els.kieApiKeyInput.value : '';
    const debugMode = els.debugCheckbox.checked;
    const imageProvider = state.imageProvider;
    const vendorJobLimits = collectVendorJobLimitsFromForm();

    const result = await ipcRenderer.invoke('save-settings', {
      apiKey,
      kieApiKey,
      debugMode,
      imageProvider,
      vendorJobLimits
    });
    if (result.success) {
        if (state.contextSourceProviderId === state.imageProvider) {
            state.contextSourceProviderId = null;
        }
        updateModelDisplayUI();
        log('Настройки сохранены.', 'success');
        closeSettings();
    } else {
        log(`Не удалось сохранить настройки: ${result.error}`, 'error');
    }
}

els.btnSettings.addEventListener('click', openSettings);
els.btnCloseSettings.addEventListener('click', closeSettings);
els.btnSaveSettings.addEventListener('click', saveSettings);

if (els.settingsTabKeys) els.settingsTabKeys.addEventListener('click', () => showSettingsTab('keys'));
if (els.settingsTabLimits) els.settingsTabLimits.addEventListener('click', () => showSettingsTab('limits'));
if (els.settingsTabApp) els.settingsTabApp.addEventListener('click', () => showSettingsTab('app'));

if (els.mainProviderSelect) {
  els.mainProviderSelect.addEventListener('change', async () => {
    if (syncingMainModelSelect) return;
    const next = els.mainProviderSelect.value;
    state.imageProvider = next;
    if (next === state.contextSourceProviderId) state.contextSourceProviderId = null;
    try {
      await ipcRenderer.invoke('save-settings', {
        imageProvider: next,
        debugMode: els.debugCheckbox.checked
      });
    } catch (e) {
      log(`Не удалось сохранить модель: ${e.message}`, 'warn');
    }
    updateModelDisplayUI();
    updateStateUI();
  });
}

if (els.btnSwitchContextModel) {
  els.btnSwitchContextModel.addEventListener('click', async () => {
    if (!state.contextSourceProviderId) return;
    const next = state.contextSourceProviderId;
    try {
      await ipcRenderer.invoke('save-settings', {
        imageProvider: next,
        debugMode: els.debugCheckbox.checked
      });
      state.imageProvider = next;
      state.contextSourceProviderId = null;
      populateMainModelSelect();
      updateStateUI();
      log(`Выбрана модель: ${getProviderDisplayLabel(next)}`, 'success');
    } catch (e) {
      log(`Не удалось переключить модель: ${e.message}`, 'error');
    }
  });
}

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

ipcRenderer.on('request-log', (event, msg) => {
  log(msg, 'info');
});

// --- UI Updates ---
function updateStateUI() {
  syncGenerationControls();
  // Resolution
  Array.from(els.resGroup.children).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === state.resolution);
  });
  // Ratio
  Array.from(els.ratioGroup.children).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === state.aspectRatio);
  });
  Array.from(els.qualityGroup.children).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === state.quality);
  });
  // Prompt
  els.prompt.value = state.prompt || '';
  els.charCounter.textContent = els.prompt.value.length;
  
  // References
  els.refCount.textContent = `${state.references.length} / 9`;
  renderRefList();

  updateModelDisplayUI();
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
        container.title = 'Нажмите, чтобы удалить';
        
        const img = document.createElement('img');
        img.src = `data:${ref.mimeType};base64,${ref.data}`;
        img.className = 'ref-thumb';
        
        const overlay = document.createElement('div');
        overlay.className = 'ref-thumb-overlay';
        overlay.textContent = '✕';
        
        container.appendChild(img);
        container.appendChild(overlay);
        
        setupHoverPreview(container, () => img.src);

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
        promptEl.textContent = req.prompt || '(Без промпта)';
        
        const metaEl = document.createElement('div');
        metaEl.className = 'request-meta';
        metaEl.textContent = `${req.resolution} • ${req.ratio} • ${new Date(req.timestamp).toLocaleTimeString()}`;
        
        infoDiv.appendChild(promptEl);
        infoDiv.appendChild(metaEl);
        
        item.appendChild(iconDiv);
        item.appendChild(infoDiv);

        if (req.status === 'error' && req.kieTaskId && req.provider?.startsWith('kie_')) {
          const retryBtn = document.createElement('button');
          retryBtn.type = 'button';
          retryBtn.className = 'request-retry-btn';
          retryBtn.textContent = '🔄';
          retryBtn.title = 'Проверить статус задачи Kie';
          retryBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const res = await ipcRenderer.invoke('kie-recover-task', {
              taskId: req.kieTaskId,
              prompt: req.prompt,
              resolution: req.resolution,
              ratio: req.ratio,
              quality: req.quality,
              referenceImages: req.references.map((r) => ({
                hash: r.hash,
                mimeType: r.mimeType,
                extension: r.extension
              })),
              project: state.activeProject ? state.activeProject.title : null,
              provider: req.provider
            });
            if (res.success) {
              req.status = 'success';
              req.resultPath = res.path;
              req.kieTaskId = null;
              req.error = null;
              log(`Запрос ${req.id} завершён после повторной проверки.`, 'success');
              loadOutputLibrary();
            } else if (res.stillPending) {
              log(`Запрос ${req.id}: задача Kie ещё выполняется.`, 'info');
            } else if (res.error) {
              log(`Повторная проверка запроса ${req.id}: ${res.error}`, 'error');
            }
            renderRequestList();
            if (state.currentRequestId === req.id) {
              updateMainView(req);
            }
          });
          item.appendChild(retryBtn);
        }
        
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
    state.quality = req.quality || null;
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
        errEl.textContent = req.error || 'Генерация не удалась';
        els.placeholder.classList.remove('hidden');
    }
}

// --- Library Management ---
async function loadOutputLibrary() {
    try {
        const files = await ipcRenderer.invoke('list-output-files', state.activeProject ? state.activeProject.title : null);
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
            
            const deleteBtn = document.createElement('div');
            deleteBtn.className = 'library-delete-btn';
            deleteBtn.textContent = '✕';
            deleteBtn.title = 'Delete Image';
            deleteBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const res = await ipcRenderer.invoke('delete-file', file.path);
                if (res.success) {
                    loadOutputLibrary();
                } else {
                    log(`Не удалось удалить: ${res.error}`, 'error');
                }
            });
            
            const topZone = document.createElement('div');
            topZone.className = 'lib-overlay-top';
            topZone.textContent = 'Референс';
            topZone.addEventListener('click', async (e) => {
                e.stopPropagation();
                await addLibraryImageToReference(file.path);
            });
            
            const bottomZone = document.createElement('div');
            bottomZone.className = 'lib-overlay-bottom';
            bottomZone.textContent = 'Контекст';
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
                // Update tag
                // We can read meta or just use what we have
                els.tag.textContent = `${state.resolution} • ${state.aspectRatio}`; // state updated by restoreContext
                els.tag.classList.remove('hidden');
            });

            div.appendChild(img);
            div.appendChild(counterSpan);
            div.appendChild(deleteBtn);
            div.appendChild(topZone);
            div.appendChild(bottomZone);
            
            setupHoverPreview(div, () => img.src);

            els.libraryListOutput.appendChild(div);
        });

        const endBar = document.createElement('div');
        endBar.style.height = '2px';
        endBar.style.backgroundColor = 'white';
        endBar.style.marginTop = '0px';
        endBar.style.flexShrink = '0';
        els.libraryListOutput.appendChild(endBar);

    } catch (e) {
        log(`Ошибка загрузки результатов: ${e.message}`, 'error');
    }
}

async function loadInputLibrary() {
    try {
        const files = await ipcRenderer.invoke('list-input-files', state.activeProject ? state.activeProject.title : null);
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
            
            const deleteBtn = document.createElement('div');
            deleteBtn.className = 'library-delete-btn';
            deleteBtn.textContent = '✕';
            deleteBtn.title = 'Delete Image';
            deleteBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const res = await ipcRenderer.invoke('delete-file', file.path);
                if (res.success) {
                    loadInputLibrary();
                } else {
                    log(`Не удалось удалить: ${res.error}`, 'error');
                }
            });
            
            const overlay = document.createElement('div');
            overlay.className = 'lib-overlay-single';
            
            overlay.addEventListener('click', async (e) => {
                e.stopPropagation();
                await addLibraryImageToReference(file.path);
            });

            div.appendChild(img);
            div.appendChild(counterSpan);
            div.appendChild(deleteBtn);
            div.appendChild(overlay);
            
            setupHoverPreview(div, () => img.src);

            els.libraryListInput.appendChild(div);
        });

        const endBar = document.createElement('div');
        endBar.style.height = '2px';
        endBar.style.backgroundColor = 'white';
        endBar.style.marginTop = '0px';
        endBar.style.flexShrink = '0';
        els.libraryListInput.appendChild(endBar);

    } catch (e) {
        log(`Ошибка загрузки входящих файлов: ${e.message}`, 'error');
    }
}

async function addLibraryImageToReference(filePath) {
    try {
        const buffer = fs.readFileSync(filePath);
        const hash = crypto.createHash('md5').update(buffer).digest('hex');
        
        const existingIdx = state.references.findIndex(r => r.hash === hash);
        if (existingIdx !== -1) {
            removeRef(existingIdx);
            log('Референс удалён.', 'info');
            return;
        }

        if (state.references.length >= 9) {
            log('Достигнут лимит референсов (9).', 'warn');
            return;
        }

        let ext = path.extname(filePath).substring(1);
        
        const saveName = `${hash}.${ext}`;
        const savePath = path.join(INPUT_DIR, saveName); // Uses active INPUT_DIR
        
        if (!fs.existsSync(savePath)) {
            fs.writeFileSync(savePath, buffer);
            log(`Saved to references: ${saveName}`);
        }
        
        const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';

        state.references.push({
            hash,
            mimeType,
            data: buffer.toString('base64'),
            extension: ext
        });
        
        updateStateUI();
        log('Референс добавлен.', 'success');

    } catch (err) {
        log(`Не удалось добавить референс: ${err.message}`, 'error');
    }
}

async function importImagesToInput(files) {
  if (!INPUT_DIR) {
    log('Приложение инициализируется, подождите...', 'error');
    return;
  }

  let imported = 0;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const filePath = getFilePath(file);
    if (!filePath) {
      log(`Не удалось определить путь к файлу: ${file.name}`, 'error');
      continue;
    }

    const ext = path.extname(file.name).slice(1).toLowerCase();
    if (!['png', 'jpg', 'jpeg'].includes(ext)) {
      log(`Формат «${file.name}» пока не поддерживается. Используйте PNG или JPEG.`, 'warn');
      continue;
    }

    try {
      const buffer = fs.readFileSync(filePath);
      const hash = crypto.createHash('md5').update(buffer).digest('hex');
      const target = path.join(INPUT_DIR, `${hash}.${ext}`);
      if (!fs.existsSync(target)) {
        fs.writeFileSync(target, buffer);
        imported++;
      }
    } catch (error) {
      log(`Не удалось импортировать «${file.name}»: ${error.message}`, 'error');
    }
  }

  if (imported) {
    log(`Импортировано изображений: ${imported}.`, 'success');
    await loadInputLibrary();
  }
}

function setupInputLibraryDrop() {
  if (!els.libraryListInput) return;
  els.libraryListInput.addEventListener('dragover', (event) => {
    event.preventDefault();
    els.libraryListInput.classList.add('drag-over');
  });
  els.libraryListInput.addEventListener('dragleave', () => {
    els.libraryListInput.classList.remove('drag-over');
  });
  els.libraryListInput.addEventListener('drop', async (event) => {
    event.preventDefault();
    els.libraryListInput.classList.remove('drag-over');
    await importImagesToInput(event.dataTransfer.files);
  });
}

async function openLibraryFolder(kind) {
  const result = await ipcRenderer.invoke(
    'open-library-folder',
    kind,
    state.activeProject ? state.activeProject.title : null
  );
  if (!result.success) log(`Не удалось открыть папку: ${result.error}`, 'error');
}

els.inputLibraryHeader?.addEventListener('click', () => openLibraryFolder('input'));
els.outputLibraryHeader?.addEventListener('click', () => openLibraryFolder('output'));
setupInputLibraryDrop();

// --- Interaction ---

els.resetBtn.addEventListener('click', () => {
    state.resolution = '1K';
    state.aspectRatio = '1:1';
    state.quality = null;
    state.references = [];
    state.prompt = '';
    state.contextSourceProviderId = null;

    // We do not clear the request list, just the context form
    state.currentRequestId = null;
    
    els.resultImage.src = '';
    els.resultImage.classList.add('hidden');
    els.placeholder.classList.remove('hidden');
    els.tag.classList.add('hidden');
    
    // Clear error msg if any
    const errEl = els.placeholder.querySelector('.error-msg');
    if (errEl) errEl.remove();
    const icon = els.placeholder.querySelector('.placeholder-icon');
    if (icon) icon.textContent = '🖼️';
    
    updateStateUI();
    renderRequestList(); // to remove active selection
    log('Контекст сброшен.');
});

function getFilePath(file) {
    if (file.path) return file.path;
    if (webUtils && webUtils.getPathForFile) return webUtils.getPathForFile(file);
    return null;
}

els.resGroup.addEventListener('click', async e => {
  if (e.target.tagName === 'BUTTON') {
    state.resolution = e.target.dataset.value;
    updateStateUI();
    await ipcRenderer.invoke('save-settings', { resolution: state.resolution, debugMode: els.debugCheckbox.checked, imageProvider: state.imageProvider });
  }
});

els.ratioGroup.addEventListener('click', async e => {
  if (e.target.tagName === 'BUTTON') {
    state.aspectRatio = e.target.dataset.value;
    updateStateUI();
    await ipcRenderer.invoke('save-settings', { aspectRatio: state.aspectRatio, debugMode: els.debugCheckbox.checked, imageProvider: state.imageProvider });
  }
});

els.qualityGroup.addEventListener('click', async e => {
  if (e.target.tagName === 'BUTTON') {
    state.quality = e.target.dataset.value;
    updateStateUI();
    await ipcRenderer.invoke('save-settings', { quality: state.quality, debugMode: els.debugCheckbox.checked, imageProvider: state.imageProvider });
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
      log('Приложение инициализируется, подождите...', 'error');
      return;
  }

  for (const file of files) {
    if (state.references.length >= 9) break;
    if (!file.type.startsWith('image/')) continue;

    const filePath = getFilePath(file);
    if (!filePath) {
        log(`Не удалось определить путь к файлу: ${file.name}`, 'error');
        continue;
    }

    try {
      const buffer = fs.readFileSync(filePath);
      const hash = crypto.createHash('md5').update(buffer).digest('hex');
      let ext = path.extname(file.name).substring(1); 
      if (!ext) ext = 'png'; 
      
      const saveName = `${hash}.${ext}`;
      const savePath = path.join(INPUT_DIR, saveName); // Uses active INPUT_DIR
      
      if (!fs.existsSync(savePath)) {
          fs.writeFileSync(savePath, buffer);
          log(`Saved: ${saveName}`);
      }
      
      if (state.references.some(r => r.hash === hash)) {
          log('Изображение уже добавлено в референсы.');
          continue;
      }

      const base64 = buffer.toString('base64');
      state.references.push({
        hash,
        mimeType: file.type,
        data: base64,
        extension: ext
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
  }
});

async function restoreContext(filePath) {
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
      state.quality = data.quality === 'basic' || data.quality === 'high' ? data.quality : null;

      let restoredProvider = data.provider;
      if (!restoredProvider || restoredProvider === 'gemini') {
          restoredProvider = 'ai_studio_nano_banana_pro';
      }
      const list = getProviderList();
      const providerKnown = list.some((p) => p.id === restoredProvider);

      if (providerKnown) {
        state.imageProvider = restoredProvider;
        state.contextSourceProviderId = null;
        populateMainModelSelect();
      } else {
        state.contextSourceProviderId = null;
      }

      state.prompt = data.prompt || '';
      els.prompt.value = state.prompt;
      
      state.references = [];
      if (data.referenceImages && Array.isArray(data.referenceImages)) {
          const files = fs.readdirSync(INPUT_DIR); // Uses active INPUT_DIR
          
          for (const ref of data.referenceImages) {
              const match = files.find(f => f.startsWith(ref.hash));
              if (match) {
                  const refPath = path.join(INPUT_DIR, match);
                  const refBuffer = fs.readFileSync(refPath);
                  const ext = path.extname(match).substring(1);

                  state.references.push({
                      hash: ref.hash,
                      mimeType: ref.mimeType,
                      data: refBuffer.toString('base64'),
                      extension: ext
                  });
              }
          }
      }
      
      updateStateUI();
      els.charCounter.textContent = els.prompt.value.length;
    }
  } catch {
    /* silent */
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
    log('Введите промпт.', 'error');
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
      quality: state.quality,
      provider: state.imageProvider,
      // Deep copy refs
      references: JSON.parse(JSON.stringify(state.references)),
      timestamp: new Date(),
      resultPath: null,
      error: null,
      kieTaskId: null
  };

  // Add to start of list
  state.requests.unshift(reqObj);
  
  // Select it
  state.currentRequestId = reqId;
  
  renderRequestList();
  updateMainView(reqObj);
  
  log(`Запрос добавлен в очередь: ${reqId}`);

  const requestData = {
    prompt: reqObj.prompt,
    resolution: reqObj.resolution,
    ratio: reqObj.ratio,
    quality: reqObj.quality,
    referenceImages: reqObj.references.map(r => ({ hash: r.hash, mimeType: r.mimeType, extension: r.extension })),
    project: state.activeProject ? state.activeProject.title : null,
    provider: reqObj.provider
  };

  // Call IPC without await blocking the function
  ipcRenderer.invoke('generate-image', requestData)
    .then(result => {
        const r = state.requests.find(x => x.id === reqId);
        if (!r) return; // Should not happen

        if (result.success) {
            r.status = 'success';
            r.resultPath = result.path;
            log(`Запрос ${reqId} завершён.`, 'success');
            loadOutputLibrary(); // Refresh library
        } else {
            r.status = 'error';
            r.error = result.error;
            r.kieTaskId = result.kieTaskId || null;
            log(`Ошибка запроса ${reqId}: ${result.error}`, 'error');
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
        log(`Сбой запроса ${reqId}: ${err.message}`, 'error');
        
        renderRequestList();
        if (state.currentRequestId === reqId) {
            updateMainView(r);
        }
    });
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


// --- Conveyor Logic ---

function updateConveyorStatusUI() {
    if (state.activeConveyor) {
        els.conveyorStatusBox.classList.remove('hidden');
        els.conveyorPromptPreview.textContent = state.activeConveyor.prompt || '(Без промпта)';
        els.conveyorCounter.textContent = `${state.activeConveyor.currentIdx} / ${state.activeConveyor.total}`;
    } else {
        els.conveyorStatusBox.classList.add('hidden');
    }
}

function setupConveyorUI() {
    // Selection Groups
    if (els.groupGenRefs) {
        els.groupGenRefs.addEventListener('click', () => setConveyorSelectionTarget('general'));
    }
    if (els.groupConvRefs) {
        els.groupConvRefs.addEventListener('click', () => setConveyorSelectionTarget('conveyor'));
    }

    // Resolution & Ratio
    els.conveyorResGroup.addEventListener('click', e => {
        if (e.target.tagName === 'BUTTON') {
            state.conveyorDraft.resolution = e.target.dataset.value;
            updateConveyorSettingsUI();
        }
    });

    els.conveyorRatioGroup.addEventListener('click', e => {
        if (e.target.tagName === 'BUTTON') {
            state.conveyorDraft.aspectRatio = e.target.dataset.value;
            updateConveyorSettingsUI();
        }
    });
}

function setConveyorSelectionTarget(target) {
    state.conveyorSelectionTarget = target;
    
    // UI Update
    if (target === 'general') {
        els.groupGenRefs.classList.add('group-active');
        els.groupConvRefs.classList.remove('group-active');
    } else {
        els.groupGenRefs.classList.remove('group-active');
        els.groupConvRefs.classList.add('group-active');
    }
}

function updateConveyorSettingsUI() {
    Array.from(els.conveyorResGroup.children).forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === state.conveyorDraft.resolution);
    });
    Array.from(els.conveyorRatioGroup.children).forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === state.conveyorDraft.aspectRatio);
    });
}

function autoResizeTextarea(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
}

function setupAutoResize() {
    [els.prompt, els.conveyorPromptInput].forEach(textarea => {
        textarea.addEventListener('input', () => autoResizeTextarea(textarea));
    });
}

// 1. Creation Modal
els.btnAddConveyor.addEventListener('click', async () => {
    // Reset draft
    state.conveyorDraft = { 
        prompt: '', 
        resolution: state.resolution, // Use current global state
        aspectRatio: state.aspectRatio, // Use current global state
        generalRefs: [], 
        conveyorRefs: [] 
    };
    els.conveyorPromptInput.value = '';
    
    // Default selection
    setConveyorSelectionTarget('conveyor');
    updateConveyorSettingsUI();
    updateConveyorDraftUI();
    
    // Initial resize
    autoResizeTextarea(els.conveyorPromptInput);
    
    await loadConveyorLibrary();
    els.conveyorOverlay.classList.remove('hidden');
});

els.btnCloseConveyor.addEventListener('click', () => {
    els.conveyorOverlay.classList.add('hidden');
});

async function loadConveyorLibrary() {
    els.conveyorLibraryGrid.innerHTML = '';
    try {
        const inputs = await ipcRenderer.invoke('list-input-files', state.activeProject ? state.activeProject.title : null);
        const outputs = await ipcRenderer.invoke('list-output-files', state.activeProject ? state.activeProject.title : null);
        
        // Merge and sort by time
        const allFiles = [...inputs, ...outputs].sort((a, b) => b.mtime - a.mtime);
        
        allFiles.forEach(file => {
            const div = document.createElement('div');
            div.className = 'conveyor-lib-item';
            div.title = 'Нажмите, чтобы добавить в выбранный список';
            
            const img = document.createElement('img');
            img.src = `file://${file.path}`;
            
            div.addEventListener('click', () => addToConveyorDraft(file));
            
            div.appendChild(img);
            els.conveyorLibraryGrid.appendChild(div);
        });
    } catch (e) {
        log(`Ошибка загрузки библиотеки пакета: ${e.message}`, 'error');
    }
}

function addToConveyorDraft(file) {
    const type = state.conveyorSelectionTarget;
    if (type === 'general') {
        if (state.conveyorDraft.generalRefs.find(f => f.path === file.path)) return; // No dupes
        state.conveyorDraft.generalRefs.push(file);
    } else {
        state.conveyorDraft.conveyorRefs.push(file);
    }
    updateConveyorDraftUI();
}

function updateConveyorDraftUI() {
    // General Refs
    els.conveyorGenRefList.innerHTML = '';
    els.conveyorGenRefCount.textContent = `(${state.conveyorDraft.generalRefs.length})`;
    state.conveyorDraft.generalRefs.forEach((file, idx) => {
        const img = document.createElement('img');
        img.src = `file://${file.path}`;
        img.className = 'mini-ref-thumb';
        img.title = 'Нажмите, чтобы удалить';
        img.addEventListener('click', (e) => {
            e.stopPropagation(); // prevent group selection if any
            state.conveyorDraft.generalRefs.splice(idx, 1);
            updateConveyorDraftUI();
        });
        els.conveyorGenRefList.appendChild(img);
    });

    // Conveyor Refs
    els.conveyorImgList.innerHTML = '';
    els.conveyorImgCount.textContent = `(${state.conveyorDraft.conveyorRefs.length})`;
    state.conveyorDraft.conveyorRefs.forEach((file, idx) => {
        const img = document.createElement('img');
        img.src = `file://${file.path}`;
        img.className = 'mini-ref-thumb';
        img.title = 'Нажмите, чтобы удалить';
        img.addEventListener('click', (e) => {
             e.stopPropagation(); // prevent group selection if any
            state.conveyorDraft.conveyorRefs.splice(idx, 1);
            updateConveyorDraftUI();
        });
        els.conveyorImgList.appendChild(img);
    });
}

// 2. Execution
els.btnExecuteConveyor.addEventListener('click', () => {
    const prompt = els.conveyorPromptInput.value.trim();
    if (!prompt) {
        alert('Введите общий промпт.');
        return;
    }
    if (state.conveyorDraft.conveyorRefs.length === 0) {
        alert('Добавьте хотя бы одно изображение для пакетной обработки.');
        return;
    }

    // Create Conveyor Object
    const conveyor = {
        id: Date.now(),
        prompt: prompt,
        resolution: state.conveyorDraft.resolution,
        aspectRatio: state.conveyorDraft.aspectRatio,
        // Clone lists
        generalRefs: [...state.conveyorDraft.generalRefs],
        conveyorRefs: [...state.conveyorDraft.conveyorRefs],
        currentIdx: 0,
        total: state.conveyorDraft.conveyorRefs.length
    };

    state.conveyorQueue.push(conveyor);
    
    // UI Update
    els.conveyorOverlay.classList.add('hidden');
    updateConveyorStatusUI();
    
    // Start if not running
    if (!state.isConveyorRunning) {
        processConveyorQueue();
    } else {
        log('Пакет добавлен в очередь.');
    }
});

async function processConveyorQueue() {
    if (state.conveyorQueue.length === 0) {
        state.isConveyorRunning = false;
        state.activeConveyor = null;
        updateConveyorStatusUI();
        log('Все пакетные задачи завершены.');
        return;
    }

    state.isConveyorRunning = true;
    state.activeConveyor = state.conveyorQueue[0];
    updateConveyorStatusUI();

    const conv = state.activeConveyor;
    log(`Запуск пакета ${conv.id}. Задач: ${conv.total}`);

    while (conv.currentIdx < conv.total) {
        // Check if still active (might be stopped by user)
        if (state.activeConveyor !== conv) return; 

        // 1. Prepare Request
        const currentRefImage = conv.conveyorRefs[conv.currentIdx];
        
        // Convert files to the format generate-image expects
        // It needs { hash, mimeType, extension }
        // We have file paths. We need to read them to get hash/mime.
        // Helper to prepare ref object
        const prepareRef = (filePath) => {
            const buffer = fs.readFileSync(filePath);
            const hash = crypto.createHash('md5').update(buffer).digest('hex');
            const ext = path.extname(filePath).substring(1);
            const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
            return { hash, mimeType, extension: ext };
        };

        const finalRefs = [];
        // Add General Refs
        for (const f of conv.generalRefs) finalRefs.push(prepareRef(f.path));
        // Add Current Conveyor Ref
        finalRefs.push(prepareRef(currentRefImage.path));

        const reqId = Date.now(); // unique ID for this sub-request
        
        // UI Update (Counter)
        updateConveyorStatusUI();
        
        try {
            log(`Пакет ${conv.id}: генерация ${conv.currentIdx + 1}/${conv.total}...`);
            const result = await ipcRenderer.invoke('generate-image', {
                prompt: conv.prompt,
                resolution: conv.resolution || '1K',
                ratio: conv.aspectRatio || '1:1',
                referenceImages: finalRefs,
                project: state.activeProject ? state.activeProject.title : null,
                provider: state.imageProvider
            });

            if (result.success) {
                log(`Пакетная задача завершена: ${path.basename(result.path)}`, 'success');
                loadOutputLibrary(); // Refresh library after each success
            } else {
                log(`Ошибка пакетной задачи: ${result.error}`, 'error');
            }
        } catch (err) {
            log(`Сбой пакетной задачи: ${err.message}`, 'error');
        }

        conv.currentIdx++;
        updateConveyorStatusUI();
    }

    // Done with this conveyor
    state.conveyorQueue.shift(); // Remove head
    processConveyorQueue(); // Process next
}

els.btnStopConveyor.addEventListener('click', () => {
    if (state.activeConveyor) {
        if (confirm('Остановить текущую пакетную задачу?')) {
            state.activeConveyor = null; // Break loop
            state.conveyorQueue.shift(); // Remove current
            state.isConveyorRunning = false;
            processConveyorQueue(); // Will likely just stop or pick next
        }
    }
});

// Hover Logic
els.conveyorStatusBox.addEventListener('mouseenter', () => {
    // Show Overlays
    updateDetailsOverlay(state.activeConveyor);
    updateQueueOverlay();
    
    els.conveyorDetailsOverlay.classList.remove('hidden');
    if (state.conveyorQueue.length > 1) {
        els.conveyorQueueOverlay.classList.remove('hidden');
    }
    
    // Position
    const rect = els.conveyorStatusBox.getBoundingClientRect();
    // Detail (Right)
    els.conveyorDetailsOverlay.style.left = `${rect.right + 10}px`;
    els.conveyorDetailsOverlay.style.top = `${rect.top}px`;
    
    // Queue (Above)
    els.conveyorQueueOverlay.style.left = `${rect.left}px`;
    els.conveyorQueueOverlay.style.bottom = `${window.innerHeight - rect.top + 10}px`;
});

els.conveyorStatusBox.addEventListener('mouseleave', () => {
    els.conveyorDetailsOverlay.classList.add('hidden');
    els.conveyorQueueOverlay.classList.add('hidden');
});

function updateDetailsOverlay(conv) {
    if (!conv) return;
    els.detailsPrompt.textContent = conv.prompt;
    
    // Gen Refs
    els.detailsGenRefs.innerHTML = '';
    conv.generalRefs.forEach(f => {
        const img = document.createElement('img');
        img.src = `file://${f.path}`;
        els.detailsGenRefs.appendChild(img);
    });
    
    // Conveyor List
    els.detailsConvList.innerHTML = '';
    conv.conveyorRefs.forEach((f, idx) => {
        const img = document.createElement('img');
        img.src = `file://${f.path}`;
        // Highlight current?
        if (idx === conv.currentIdx) {
            img.style.border = '2px solid var(--accent-color)';
        } else if (idx < conv.currentIdx) {
            img.style.opacity = '0.5';
        }
        els.detailsConvList.appendChild(img);
    });
}

function updateQueueOverlay() {
    els.conveyorQueueList.innerHTML = '';
    // Skip first (active)
    const queue = state.conveyorQueue.slice(1);
    
    if (queue.length === 0) return;

    queue.forEach(conv => {
        const item = document.createElement('div');
        item.className = 'queue-item';
        item.innerHTML = `
            <div style="font-weight:bold; color:var(--accent-color)">${conv.total} images</div>
            <div style="font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${conv.prompt}</div>
        `;
        
        item.addEventListener('mouseenter', () => {
            updateDetailsOverlay(conv); // Show details for this queued item
        });
        
        // On leave, show active again?
        item.addEventListener('mouseleave', () => {
            updateDetailsOverlay(state.activeConveyor);
        });

        els.conveyorQueueList.appendChild(item);
    });
}
