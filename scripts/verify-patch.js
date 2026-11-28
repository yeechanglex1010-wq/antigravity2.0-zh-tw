const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const vm = require('vm');
const asar = require('@electron/asar');

const engine = require('../localization_engine');

const REPO_ROOT = path.resolve(__dirname, '..');
const DICTS_DIR = path.join(REPO_ROOT, 'dicts');

function resolveDefaultAsarPath() {
    const candidates = [
        process.env.ANTIGRAVITY_ASAR_PATH,
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity', 'resources', 'app.asar'),
        'C:\\Program Files\\Antigravity\\resources\\app.asar',
        '/Applications/Antigravity.app/Contents/Resources/app.asar',
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

function sha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function countOccurrences(haystack, needle) {
    return haystack.split(needle).length - 1;
}

function verifyDictionaries() {
    const files = fs.readdirSync(DICTS_DIR).filter(f => f.endsWith('.json')).sort();
    assert(files.length === 6, `Expected 6 dictionary files, found ${files.length}`);

    const seenExact = new Map();
    let total = 0;

    for (const file of files) {
        const content = fs.readFileSync(path.join(DICTS_DIR, file), 'utf-8');
        const data = JSON.parse(content);
        const keys = Object.keys(data);
        assert(keys.length > 0, `Dictionary ${file} is empty`);

        for (const key of keys) {
            const val = data[key];
            assert(typeof val === 'string' && val.trim().length > 0, `Invalid value for ${key} in ${file}`);
            if (seenExact.has(key)) {
                const prev = seenExact.get(key);
                assert.strictEqual(prev.val, val, `Contradictory duplicate key "${key}" in ${file} vs ${prev.file}`);
            } else {
                seenExact.set(key, { file, val });
            }
            total++;
        }
    }

    const loaded = engine.loadDictionary();
    assert(Object.keys(loaded).length >= 1500, `Expected >= 1500 loaded dictionary entries, got ${Object.keys(loaded).length}`);
    console.log(`[PASS] Dictionaries verified: ${files.length} files, ${total} total entries (${Object.keys(loaded).length} normalized keys).`);
}

function runSyntaxChecks(unpackedDir) {
    const targets = [
        'dist/preload.js',
        'dist/menu.js',
        'dist/tray.js',
        'dist/main.js',
        'dist/updater.js',
        'dist/provisionSplash.js',
        'dist/remote/disconnectedPage.js',
        'dist/ideInstall/wizardHtml.js',
        'dist/loadingOverlay.js',
    ];

    let checked = 0;
    for (const rel of targets) {
        const fullPath = path.join(unpackedDir, rel);
        if (!fs.existsSync(fullPath)) continue;
        execFileSync(process.execPath, ['--check', fullPath], { stdio: 'pipe' });
        checked++;
    }
    assert(checked >= 6, `Expected at least 6 target JS files checked, got ${checked}`);
    console.log(`[PASS] Node syntax check passed for ${checked} patched dist files.`);
}

function runWithModuleMocks(filePath, mocks) {
    const originalLoad = Module._load;
    delete require.cache[require.resolve(filePath)];
    Module._load = function (request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(mocks, request)) {
            return mocks[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return require(filePath);
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve(filePath)];
    }
}

async function verifyPatchedMenuBehavior(unpackedDir) {
    const menuPath = path.join(unpackedDir, 'dist', 'menu.js');
    let currentMenu = null;
    let checkUpdatesInvoked = false;

    class MockMenuItem {
        constructor(opts) {
            Object.assign(this, opts);
            if (Array.isArray(opts.submenu)) {
                this.submenu = new MockMenu(opts.submenu.map(s => new MockMenuItem(s)));
            }
        }
    }

    class MockMenu {
        constructor(items = []) {
            this.items = items;
        }
        insert(idx, item) {
            this.items.splice(idx, 0, item);
        }
        clear() {}
        static buildFromTemplate(tpl) {
            return new MockMenu(tpl.map(t => new MockMenuItem(t)));
        }
        static getApplicationMenu() {
            return currentMenu;
        }
        static setApplicationMenu(menu) {
            currentMenu = menu;
        }
    }

    currentMenu = new MockMenu([
        new MockMenuItem({ label: 'Antigravity', submenu: new MockMenu([new MockMenuItem({ label: 'Quit' })]) }),
        new MockMenuItem({ label: '&File', submenu: new MockMenu([new MockMenuItem({ label: 'Close Window' })]) }),
        new MockMenuItem({ label: '&Edit', submenu: new MockMenu([new MockMenuItem({ label: 'Cut' }), new MockMenuItem({ label: 'Copy' })]) }),
        new MockMenuItem({
            label: '&View',
            submenu: new MockMenu([
                new MockMenuItem({ role: 'resetzoom', label: 'Actual Size' }),
                new MockMenuItem({ role: 'zoomin', label: 'Zoom In' }),
                new MockMenuItem({ role: 'zoomout', label: 'Zoom Out' }),
            ]),
        }),
        new MockMenuItem({ label: '&Help', submenu: new MockMenu([]) }),
    ]);

    const mockUpdater = {
        MenuUpdateStep: {
            CheckForUpdates: 'Check for Updates',
            CheckingForUpdates: 'Checking for Updates...',
            DownloadingUpdate: 'Downloading Update...',
            RestartToUpdate: 'Restart to Update',
        },
        updateActions: {
            'Check for Updates': () => { checkUpdatesInvoked = true; },
            'Checking for Updates...': undefined,
            'Downloading Update...': undefined,
            'Restart to Update': () => {},
        },
    };

    const menuMod = runWithModuleMocks(menuPath, {
        electron: { Menu: MockMenu, MenuItem: MockMenuItem, shell: { openExternal: async () => {} }, app: { getPath: () => os.tmpdir(), relaunch: () => {}, quit: () => {} } },
        './authBootstrap': { getActiveLsPort: () => 12345 },
        './constants': { WINDOW_ORIGIN: 'https://127.0.0.1' },
        './utils': { isMacOS: () => true, resolveCurrentHubUrl: u => u, createWindow: () => {} },
        './updater': mockUpdater,
        './wsl': {
            isWslAvailable: () => true,
            listWslDistros: async () => [{ name: 'Ubuntu' }],
            getActiveWslDistro: () => 'Ubuntu',
            persistWslDistro: () => {},
            WSL_STATE_FILE: 'wsl.json',
        },
        './debugConsole': { configureDebugConsoleMenu: () => {} },
        './hubZoom': { applyHubWindowZoom: async () => {}, resolveTargetHubWindow: w => w },
    });

    menuMod.setupApplicationMenu('https://127.0.0.1:12345');
    // Allow async addWslConnectMenu microtasks to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    const fileMenu = currentMenu.items.find(i => i.label.startsWith('檔案'));
    assert(fileMenu, 'File menu should be translated to 檔案');
    const fileLabels = fileMenu.submenu.items.map(i => i.label);
    assert(fileLabels.includes('新增視窗'), `Expected 新增視窗 in File submenu, got: ${JSON.stringify(fileLabels)}`);
    assert(fileLabels.includes('連線至 WSL'), `Expected async 連線至 WSL in File submenu, got: ${JSON.stringify(fileLabels)}`);
    assert(fileLabels.includes('在本機重新開啟'), `Expected async 本機重新開啟 in File submenu, got: ${JSON.stringify(fileLabels)}`);

    const viewMenu = currentMenu.items.find(i => i.label.startsWith('檢視'));
    assert(viewMenu, 'View menu should be translated to 檢視');
    const viewLabels = viewMenu.submenu.items.map(i => i.label);
    assert(viewLabels.includes('放大') && viewLabels.includes('縮小') && viewLabels.includes('實際大小'), `Unexpected View labels: ${JSON.stringify(viewLabels)}`);

    const appSub = currentMenu.items[0].submenu.items;
    const updateItem = appSub.find(i => i.id === 'check-for-updates');
    assert(updateItem && updateItem.label === '檢查更新', 'macOS Check for Updates item should be translated');
    updateItem.click(updateItem);
    assert(checkUpdatesInvoked, 'Clicking translated 檢查更新 item should invoke updateActions');

    console.log('[PASS] Patched dist/menu.js behavioral check passed (sync + async WSL + macOS update action).');
}

function verifyPatchedTrayBehavior(unpackedDir) {
    const trayPath = path.join(unpackedDir, 'dist', 'tray.js');
    let lastContextMenu = null;
    let trayClickHandler = null;

    class MockMenuItem {
        constructor(opts) {
            Object.assign(this, opts);
        }
    }
    class MockMenu {
        constructor(items = []) {
            this.items = items;
        }
        insert(pos, item) {
            this.items.splice(pos, 0, item);
        }
        static buildFromTemplate(items) {
            return new MockMenu(items.map(i => new MockMenuItem(i)));
        }
    }
    class MockTray {
        setToolTip() {}
        setContextMenu(m) { lastContextMenu = m; }
        on(evt, cb) { if (evt === 'click') trayClickHandler = cb; }
    }

    const trayMod = runWithModuleMocks(trayPath, {
        electron: {
            app: { getName: () => 'Antigravity' },
            nativeImage: { createFromPath: () => ({ setTemplateImage: () => {} }) },
            Tray: MockTray,
            Menu: MockMenu,
            MenuItem: MockMenuItem,
        },
        './utils': { isMacOS: () => false },
    });

    let clicked = false;
    trayMod.createTray(
        [
            { id: 'running-agents', label: 'No agents running', enabled: false },
            { type: 'separator' },
            { label: 'Open Antigravity' },
            { label: 'Quit' },
        ],
        () => { clicked = true; }
    );

    assert(typeof trayClickHandler === 'function', 'createTray must preserve onClick parameter');
    trayClickHandler();
    assert(clicked, 'Tray click handler should fire');

    const labels = lastContextMenu.items.map(i => i.label);
    assert(labels.includes('目前沒有執行中的 Agent'), `Missing translated No agents running: ${JSON.stringify(labels)}`);
    assert(labels.includes('開啟 Antigravity'), `Missing translated Open Antigravity: ${JSON.stringify(labels)}`);
    assert(labels.includes('結束'), `Missing translated Quit: ${JSON.stringify(labels)}`);

    trayMod.insertTrayMenuItem(2, { label: 'Connect to WSL', submenu: [{ label: 'Ubuntu' }] });
    trayMod.insertTrayMenuItem(3, { label: 'Reopen Locally' });
    const afterInsert = lastContextMenu.items.map(i => i.label);
    assert(afterInsert.includes('連線至 WSL'), `insertTrayMenuItem should translate Connect to WSL: ${JSON.stringify(afterInsert)}`);
    assert(afterInsert.includes('在本機重新開啟'), `insertTrayMenuItem should translate Reopen Locally: ${JSON.stringify(afterInsert)}`);

    trayMod.updateTrayAgentCount(0);
    assert.strictEqual(lastContextMenu.items[0].label, '目前沒有執行中的 Agent');
    trayMod.updateTrayAgentCount(3);
    assert.strictEqual(lastContextMenu.items[0].label, '3 個 Agent 執行中');

    console.log('[PASS] Patched dist/tray.js behavioral check passed (onClick, insertTrayMenuItem, updateTrayAgentCount).');
}

function verifyDomTranslatorGeneration() {
    const generated = engine.generateJs();
    const match = generated.match(/translateString\(originalVal\)\s*\{[\s\S]*?\n    \}\n\n    function isTranslatablePlaceholderElement/);
    assert(match, 'Could not locate translateString in generated preload script');

    // Run generated IIFE inside a minimal mocked DOM sandbox to verify runtime syntax & translateString
    const recorded = {};
    const sandbox = {
        window: {},
        addEventListener: () => {},
        document: {
            readyState: 'loading',
            head: { appendChild: () => {} },
            documentElement: { appendChild: () => {} },
            createElement: () => ({ id: '', textContent: '' }),
            getElementById: () => null,
            addEventListener: () => {},
            querySelectorAll: () => [],
        },
        Element: { prototype: { attachShadow: function () { return {}; }, setAttribute: function () {} } },
        Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
        MutationObserver: class { observe() {} },
        setTimeout: () => 0,
        requestAnimationFrame: () => 0,
        WeakSet,
        Map,
        Set,
        Array,
        Object,
        RegExp,
        String,
        Number,
        Boolean,
        recorded,
    };
    sandbox.window = sandbox;

    // Expose translateString for direct assertions
    const instrumented = generated.replace(
        'function translateString(originalVal) {',
        'function translateString(originalVal) {'
    ).replace(
        'document.addEventListener(\'focusin\', translateAroundPointer, true);',
        'document.addEventListener(\'focusin\', translateAroundPointer, true);\n    window.__testTranslateString = translateString;'
    );

    vm.runInNewContext(instrumented, sandbox);
    assert.strictEqual(typeof sandbox.__testTranslateString, 'function', 'Generated preload script failed to register __testTranslateString');

    const cases = [
        ['Next Page', '下一頁'],
        ['Open in Remote Control', '在遠端控制中開啟'],
        ['Enable sandbox mode', '啟用沙盒模式'],
        ['Search settings', '搜尋設定'],
        ['Needs you', '需要您處理'],
        ['Saved securely. Secret values are hidden after saving.', '已安全儲存。機密數值在儲存後會隱藏。'],
        ['Manage Hooks', '管理 Hooks'],
        ['Cookies by Site', '依網站管理 Cookie'],
        ['Show 3 breakdowns', '顯示 3 項明細'],
        ['Resume 2 comment drafts', '繼續編輯 2 則留言草稿'],
        ['Setting up WSL: Ubuntu', '正在設定 WSL：Ubuntu'],
        ['Reconnecting to prod-box…', '正在重新連線至 prod-box…'],
        ['Disconnected from prod-box', '已中斷與 prod-box 的連線'],
        ['Checking host-1…', '正在檢查 host-1…'],
        ['Weekly limit, resets in 2d 3h', '每週限制，2 天 3 小時後重置'],
    ];

    for (const [input, expected] of cases) {
        const actual = sandbox.__testTranslateString(input);
        assert.strictEqual(actual, expected, `translateString(${JSON.stringify(input)}) => ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }

    console.log(`[PASS] Generated DOM translator verified against ${cases.length} static and dynamic test cases.`);
}

async function main() {
    verifyDictionaries();
    verifyDomTranslatorGeneration();

    const sourceAsar = resolveDefaultAsarPath();
    assert(sourceAsar, 'Antigravity app.asar not found on this machine. Set ANTIGRAVITY_ASAR_PATH to run ASAR tests.');

    const originalHash = sha256(sourceAsar);
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-zh-verify-'));
    const resourcesDir = path.join(sandboxRoot, 'resources');
    fs.mkdirSync(resourcesDir, { recursive: true });
    const sandboxAsar = path.join(resourcesDir, 'app.asar');
    fs.copyFileSync(sourceAsar, sandboxAsar);
    const sourceUnpacked = path.join(path.dirname(sourceAsar), 'app.asar.unpacked');
    if (fs.existsSync(sourceUnpacked)) {
        fs.cpSync(sourceUnpacked, path.join(resourcesDir, 'app.asar.unpacked'), { recursive: true });
    }

    try {
        console.log(`[INFO] Testing install20 against sandbox copy of ${sourceAsar} ...`);
        const ok1 = engine.install20(resourcesDir);
        assert.strictEqual(ok1, true, 'First install20 failed');
        assert(fs.existsSync(path.join(resourcesDir, 'app.asar.bak')), 'Backup app.asar.bak was not created');
        engine.verifyAsar(sandboxAsar, true);

        const inspectDir1 = path.join(sandboxRoot, 'inspect1');
        asar.extractAll(sandboxAsar, inspectDir1);
        runSyntaxChecks(inspectDir1);
        await verifyPatchedMenuBehavior(inspectDir1);
        verifyPatchedTrayBehavior(inspectDir1);

        // Verify electron UI file replacements
        const mainJs = fs.readFileSync(path.join(inspectDir1, 'dist', 'main.js'), 'utf-8');
        assert(mainJs.includes("title: '確認結束'"), 'main.js Confirm Quit dialog was not patched');
        const updaterJs = fs.readFileSync(path.join(inspectDir1, 'dist', 'updater.js'), 'utf-8');
        assert(updaterJs.includes("message: '目前沒有可用更新'"), 'updater.js dialog was not patched');
        const splashJs = fs.readFileSync(path.join(inspectDir1, 'dist', 'provisionSplash.js'), 'utf-8');
        assert(splashJs.includes('正在設定 WSL：'), 'provisionSplash.js was not patched');
        const discJs = fs.readFileSync(path.join(inspectDir1, 'dist', 'remote', 'disconnectedPage.js'), 'utf-8');
        assert(discJs.includes("reconnect: '重新連線'"), 'disconnectedPage.js was not patched');

        // Idempotency test: run install20 a second time
        console.log('[INFO] Testing idempotency (second install20 on already-patched app.asar)...');
        const ok2 = engine.install20(resourcesDir);
        assert.strictEqual(ok2, true, 'Second install20 failed');
        const inspectDir2 = path.join(sandboxRoot, 'inspect2');
        asar.extractAll(sandboxAsar, inspectDir2);
        runSyntaxChecks(inspectDir2);

        const preload2 = fs.readFileSync(path.join(inspectDir2, 'dist', 'preload.js'), 'utf-8');
        const menu2 = fs.readFileSync(path.join(inspectDir2, 'dist', 'menu.js'), 'utf-8');
        const tray2 = fs.readFileSync(path.join(inspectDir2, 'dist', 'tray.js'), 'utf-8');

        // Verify unpacked chrome-devtools-mcp entries remained marked unpacked in ASAR header
        const rawHeader = asar.getRawHeader(sandboxAsar);
        const mcpEntry = rawHeader.header.files.node_modules?.files?.['chrome-devtools-mcp'];
        assert(mcpEntry && mcpEntry.unpacked === true, 'node_modules/chrome-devtools-mcp should remain marked unpacked in ASAR header');

        assert.strictEqual(countOccurrences(preload2, engine.SIGNATURE_START), 1, 'Duplicate preload injection found');
        assert.strictEqual(countOccurrences(menu2, '/* --- MENU TRANSLATION HELPER START --- */'), 1, 'Duplicate menu helper found');
        assert.strictEqual(countOccurrences(menu2, '/* --- MENU SUBMENU LOOKUP START --- */'), 1, 'Duplicate menu submenu lookup found');
        assert.strictEqual(countOccurrences(tray2, '/* --- TRAY TRANSLATION START --- */'), 1, 'Duplicate tray injection found');
        assert.strictEqual(countOccurrences(tray2, '/* --- TRAY INSERT TRANSLATION START --- */'), 1, 'Duplicate tray insert injection found');
        console.log('[PASS] Idempotency check passed (marker counts strictly 1 after re-install).');

        // Restore test
        console.log('[INFO] Testing restore20 bit-for-bit restoration...');
        const restoredOk = engine.restore20(resourcesDir);
        assert.strictEqual(restoredOk, true, 'restore20 failed');
        assert.strictEqual(fs.existsSync(path.join(resourcesDir, 'app.asar.bak')), false, 'app.asar.bak should be removed after restore');
        const restoredHash = sha256(sandboxAsar);
        assert.strictEqual(restoredHash, originalHash, 'Restored app.asar SHA-256 does not match original');
        console.log('[PASS] Bit-for-bit restore verified (SHA-256 identical).');

        // Stale backup refresh test: simulate an old unpatched app.asar.bak left over after an official update
        console.log('[INFO] Testing stale app.asar.bak refresh after official Antigravity update...');
        const staleSrcDir = path.join(sandboxRoot, 'stale-src');
        asar.extractAll(sourceAsar, staleSrcDir);
        const stalePreload = path.join(staleSrcDir, 'dist', 'preload.js');
        fs.appendFileSync(stalePreload, '\n// simulated-older-official-version\n', 'utf-8');
        const staleBakPath = path.join(resourcesDir, 'app.asar.bak');
        await asar.createPackageWithOptions(staleSrcDir, staleBakPath, { unpackDir: 'node_modules/chrome-devtools-mcp' });
        assert.notStrictEqual(sha256(staleBakPath), originalHash, 'Stale backup should differ from new official app.asar');

        assert.strictEqual(engine.install20(resourcesDir), true, 'install20 with stale backup failed');
        assert.strictEqual(sha256(staleBakPath), originalHash, 'app.asar.bak should have been refreshed to new official app.asar');
        assert.strictEqual(engine.restore20(resourcesDir), true, 'restore20 after stale-backup refresh failed');
        assert.strictEqual(sha256(sandboxAsar), originalHash, 'Restored app.asar should match new official SHA-256');
        console.log('[PASS] Stale backup refresh verified.');

        console.log('\nALL VERIFICATION CHECKS PASSED!');
    } finally {
        fs.rmSync(sandboxRoot, { recursive: true, force: true });
    }
}

main().catch(err => {
    console.error('[FAIL]', err);
    process.exit(1);
});
