const { app, BrowserWindow, globalShortcut, clipboard, ipcMain, Tray, Menu, screen, nativeImage, dialog } = require('electron')
const path = require('path')
const { execSync } = require('child_process')

// electron-store v11 uses ESM default export
let Store
try {
  Store = require('electron-store').default || require('electron-store')
} catch {
  Store = require('electron-store')
}

let store
let tray = null
let lookupWin = null
let settingsWin = null
let lastClipboard = ''

const isWindows = process.platform === 'win32'
const isLinux = process.platform === 'linux'

app.whenReady().then(() => {
  store = new Store({
    defaults: {
      provider: 'openrouter',
      openrouterKey: '',
      nobleKey: '',
      nobleBaseUrl: 'http://192.168.99.133:5051/v1',
      model: 'anthropic/claude-sonnet-4',
      serverUrl: 'http://192.168.99.47',
      hotkey: 'Ctrl+Shift+D',
      autoStart: false,
      windowScale: 100,
      ttsEngine: 'edge',
    }
  })

  createTray()
  registerHotkey()
  setupAutoStart()

  // IPC handlers
  ipcMain.handle('get-settings', () => store.store)
  ipcMain.handle('save-settings', (_e, settings) => {
    store.set(settings)
    globalShortcut.unregisterAll()
    registerHotkey()
    setupAutoStart()
    return true
  })
  ipcMain.handle('lookup', (_e, text) => doLookup(text))
  ipcMain.handle('tts', (_e, text) => doTTS(text))
  ipcMain.handle('close-lookup', () => { if (lookupWin && !lookupWin.isDestroyed()) lookupWin.hide() })

  // Show settings on first run if no API key
  const provider = store.get('provider') || 'openrouter'
  const hasKey = provider === 'noble' ? !!store.get('nobleKey') : !!store.get('openrouterKey')
  if (!hasKey) {
    openSettings()
  }

  console.log(`Sisi Lookup started. Hotkey: ${store.get('hotkey')}`)
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', (e) => e.preventDefault())

// ── Auto start ──
function setupAutoStart() {
  const autoStart = store.get('autoStart', false)
  if (app.setLoginItemSettings) {
    app.setLoginItemSettings({
      openAtLogin: autoStart,
      path: process.execPath,
      args: ['--hidden'],
    })
  }
}

// ── Tray ──
function createTray() {
  const iconPath = path.join(__dirname, '..', 'icons', 'icon.png')
  let trayIcon
  try {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  } catch {
    trayIcon = nativeImage.createEmpty()
  }
  tray = new Tray(trayIcon)
  tray.setToolTip(`Sisi Lookup (${store.get('hotkey')})`)

  const contextMenu = Menu.buildFromTemplate([
    { label: `Hotkey: ${store.get('hotkey')}`, enabled: false },
    { type: 'separator' },
    { label: 'Settings', click: openSettings },
    { label: 'Test Lookup', click: () => showLookupWindow('hello') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ])
  tray.setContextMenu(contextMenu)
  tray.on('double-click', openSettings)
}

// ── Global hotkey ──
function registerHotkey() {
  const hotkey = store.get('hotkey', 'Ctrl+Shift+D')
  // Convert user-friendly format to Electron format
  const electronHotkey = hotkey
    .replace(/Ctrl/gi, 'CommandOrControl')
    .replace(/Win/gi, 'Super')

  try {
    const ok = globalShortcut.register(electronHotkey, onHotkey)
    if (!ok) {
      console.error(`Hotkey registration failed: ${hotkey} (${electronHotkey})`)
    } else {
      console.log(`Hotkey registered: ${hotkey}`)
    }
  } catch (e) {
    console.error('Hotkey error:', e.message)
    // Try a safe fallback
    try {
      globalShortcut.register('CommandOrControl+Shift+L', onHotkey)
      console.log('Fallback hotkey registered: Ctrl+Shift+L')
    } catch {}
  }

  // Update tray tooltip
  if (tray) tray.setToolTip(`Sisi Lookup (${hotkey})`)
}

async function onHotkey() {
  try {
    // Save current clipboard
    lastClipboard = clipboard.readText() || ''

    // Simulate Ctrl+C
    simulateCopy()

    // Wait for clipboard to update
    await sleep(200)

    const text = (clipboard.readText() || '').trim()

    // Restore clipboard
    try { clipboard.writeText(lastClipboard) } catch {}

    if (!text || !/[a-zA-Z]/.test(text)) {
      console.log('No English text selected')
      return
    }

    console.log(`Looking up: "${text.substring(0, 50)}"`)
    showLookupWindow(text)
  } catch (e) {
    console.error('onHotkey error:', e)
  }
}

function simulateCopy() {
  if (isWindows) {
    try {
      execSync(
        'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^c\')"',
        { windowsHide: true, timeout: 2000 }
      )
    } catch (e) {
      console.error('simulateCopy failed:', e.message)
    }
  } else if (isLinux) {
    try {
      execSync('xdotool key ctrl+c', { timeout: 2000 })
    } catch (e) {
      console.error('simulateCopy (linux) failed:', e.message)
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Lookup window ──
function showLookupWindow(text) {
  const scale = (store.get('windowScale', 100)) / 100
  const winW = Math.round(500 * scale)
  const winH = Math.round(620 * scale)
  const cursorPos = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursorPos)
  const x = Math.min(cursorPos.x + 15, display.bounds.x + display.bounds.width - winW - 20)
  const y = Math.min(cursorPos.y + 15, display.bounds.y + display.bounds.height - winH - 20)

  if (lookupWin && !lookupWin.isDestroyed()) {
    lookupWin.setSize(winW, winH)
    lookupWin.setPosition(x, y)
    lookupWin.show()
    lookupWin.focus()
    lookupWin.webContents.send('new-lookup', text, scale)
    return
  }

  lookupWin = new BrowserWindow({
    width: winW,
    height: winH,
    x, y,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  })

  lookupWin.loadFile(path.join(__dirname, 'lookup.html'))

  lookupWin.once('ready-to-show', () => {
    lookupWin.show()
    lookupWin.focus()
    lookupWin.webContents.send('new-lookup', text, scale)
  })

  lookupWin.on('blur', () => {
    if (lookupWin && !lookupWin.isDestroyed()) lookupWin.hide()
  })
}

// ── Settings window ──
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    settingsWin.focus()
    return
  }

  settingsWin = new BrowserWindow({
    width: 420,
    height: 560,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  })

  settingsWin.loadFile(path.join(__dirname, 'settings.html'))
  settingsWin.setMenuBarVisibility(false)
}

// ── API: Lookup ──
async function doLookup(text) {
  const provider = store.get('provider') || 'openrouter'
  const openrouterKey = store.get('openrouterKey')
  const nobleKey = store.get('nobleKey')
  const nobleBaseUrl = store.get('nobleBaseUrl') || 'http://192.168.99.133:5051/v1'
  const model = store.get('model')

  let apiUrl, apiKey, headers
  if (provider === 'noble') {
    if (!nobleKey) return { error: 'Please set Noble API key in settings (right-click tray icon)' }
    apiUrl = nobleBaseUrl.replace(/\/+$/, '') + '/chat/completions'
    apiKey = nobleKey
    headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  } else {
    if (!openrouterKey) return { error: 'Please set OpenRouter API key in settings (right-click tray icon)' }
    apiUrl = 'https://openrouter.ai/api/v1/chat/completions'
    apiKey = openrouterKey
    headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://sisi-lookup.app',
    }
  }

  const isWord = text.split(/\s+/).length <= 3

  const systemPrompt = isWord
    ? `You are a bilingual English-Chinese dictionary for a 10-year-old FCE (B2) student.
Return a JSON object:
{"phonetic":"IPA","pos":"part of speech","meaning_cn":"中文释义","definition_en":"English definition","definition_cn":"英文释义的中文翻译","example_en":"example sentence","example_cn":"例句中文翻译","fce_tip":"FCE考试提示(中文), empty string if not FCE word"}
Return ONLY the JSON object.`
    : `You are a bilingual English-Chinese tutor for a 10-year-old FCE (B2) student.
Return a JSON object:
{"translation":"中文翻译","grammar":"语法分析(中文)","vocab":[{"word":"B2 word","meaning":"中文"}],"pattern":"句型说明(中文)"}
Return ONLY the JSON object.`

  try {
    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
    }
    if (provider !== 'noble') {
      body.max_tokens = 800
      body.temperature = 0.3
    }

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      return { error: `API error: ${err.error?.message || resp.status}` }
    }

    const data = await resp.json()
    const raw = data.choices?.[0]?.message?.content || ''

    try {
      const match = raw.match(/\{[\s\S]*\}/)
      if (match) return { result: JSON.parse(match[0]), isWord }
    } catch {}

    return { result: raw, isWord, isText: true }
  } catch (e) {
    return { error: e.message }
  }
}

// ── API: TTS ──
async function doTTS(text) {
  const serverUrl = store.get('serverUrl')
  const ttsEngine = store.get('ttsEngine', 'edge')
  if (!serverUrl) return { error: 'Server URL not set' }

  try {
    const resp = await fetch(`${serverUrl}/api/notes/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.trim(), provider: ttsEngine }),
    })
    if (!resp.ok) return { error: `TTS error: ${resp.status}` }

    const buffer = await resp.arrayBuffer()
    return { audio: Buffer.from(buffer).toString('base64') }
  } catch (e) {
    return { error: e.message }
  }
}
