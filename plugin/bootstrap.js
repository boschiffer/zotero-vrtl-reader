/**
 * VRTL Reader — 竖排全屏阅读
 *
 * Zotero 10 bootstrap 插件，单文件实现，无构建步骤。
 *
 * 做的事：
 *   1. 竖排模式：给 pdf.js 的 `.spread` 容器加 `flex-direction: row-reverse`，并把对开
 *      模式设为「奇数页对开」，于是页序在视觉上变成右→左（p1 在右、p2 在左）。
 *      只改 flex 方向、不改 `direction`，所以文字层 / 标注层 / 选区映射完全不受影响。
 *   2. 沉浸式全屏：隐藏 Zotero 自己的标题栏、标签栏和右侧条目面板，让阅读器铺满窗口。
 *      阅读器自身的批注工具栏与标注列表面板保持原样。
 *
 * 不做的事：不 fork 阅读器、不改批注存储、不动 pdf.js 的翻页与选区逻辑。
 */

var PLUGIN_ID = 'vrtl-reader@boschiffer.github.io';

var PREF_RTL = 'extensions.vrtl-reader.rtl';

var STYLE_RTL = 'vrtl-rtl-style';
var STYLE_UI = 'vrtl-ui-style';
var STYLE_IMM = 'vrtl-immersive-style';

var BTN_RTL = 'vrtl-btn-rtl';
var BTN_FULL = 'vrtl-btn-full';

// 注入到 pdf.js viewer 文档
var CSS_RTL = '.pdfViewer .spread { flex-direction: row-reverse !important; }';

// 注入到 reader.html 文档：文字按钮沿用 Zotero 的 .toolbar-button 外观
var CSS_UI = [
	'.toolbar-button.vrtl-btn{',
	'	width:auto !important;',
	'	padding:0 8px !important;',
	'	font-size:12px;',
	'	white-space:nowrap;',
	'}',
].join('');

// 注入到 Zotero 的 chrome 窗口文档：
// #titlebar               标题栏（菜单 + 最小化/最大化/关闭）
// #zotero-title-bar       顶部标签栏与标签菜单
// #zotero-context-pane    右侧条目详情面板（及其 splitter）
// menubar                 独立阅读器窗口的菜单栏
var CSS_IMM = [
	'#titlebar,',
	'#zotero-title-bar,',
	'#zotero-context-pane,',
	'#zotero-context-splitter,',
	'menubar{display:none !important}',
	'browser.reader{flex:1 1 auto !important;min-height:0}',
].join('');

// --- 运行时状态 ---
var _prevSpread = new WeakMap();   // ReaderInstance -> 进入竖排前的 spreadMode
var _wired = new WeakSet();        // 已绑定 keydown 的 window
var _watching = new WeakSet();     // 正在轮询等待 viewer 就绪的 reader
var _initHooked = new WeakSet();   // 已挂过 initializedPromise 的 PDFView（每次换文档都是新的）
var _listeners = [];               // { target, listener }
var _uiDocs = [];                  // { doc, chromeWin }
var _immersiveWindows = [];
var _timers = [];
var _notifierID = null;
var _pluginsObserver = null;
var _lastAction = { name: '', at: 0 };

function log(msg) {
	Zotero.debug('VRTL: ' + msg);
}

/**
 * 同一个动作在极短时间内被触发多次时只执行一次。
 * 主窗口 / reader.html / viewer 三个文档各有一份 keydown 监听，
 * 事件不会跨文档冒泡，所以去重只能靠这里。
 */
function oncePerBurst(name) {
	let now = Date.now();
	if (_lastAction.name === name && now - _lastAction.at < 400) {
		return false;
	}
	_lastAction = { name: name, at: now };
	return true;
}

// ---------------------------------------------------------------- 生命周期

function install() {}

function uninstall() {
	try {
		Zotero.Prefs.clear(PREF_RTL);
	}
	catch (e) {}
}

async function startup({ id, version, rootURI }, reason) {
	PLUGIN_ID = id;
	if (Zotero.initializationPromise) {
		await Zotero.initializationPromise;
	}
	Zotero.Reader.registerEventListener('renderToolbar', onRenderToolbar, PLUGIN_ID);
	_pluginsObserver = {
		id: PLUGIN_ID,
		// 应用退出时 Zotero 已经在拆窗口，再动 DOM 只会报错；关掉插件时才真正还原
		shutdown: (data, reason) => {
			if (reason === APP_SHUTDOWN) {
				return;
			}
			cleanup();
		}
	};
	Zotero.Plugins.addObserver(_pluginsObserver);
	// 沉浸式下标题栏和标签栏都看不见，切走或关掉阅读器标签时自动退出，避免卡在没菜单的状态
	_notifierID = Zotero.Notifier.registerObserver({
		notifierID: null,
		type: 'tab',
		notify: (event, type, ids, extraData) => {
			if (event !== 'close' && event !== 'select') {
				return;
			}
			for (let win of _immersiveWindows.slice()) {
				if (!activeReader(win)) {
					endImmersive(win);
				}
			}
			refreshUI();
		}
	}, ['tab'], PLUGIN_ID);
	// 插件启用前就打开着的阅读器：补上竖排与快捷键（按钮等下次工具栏渲染时出现）
	for (let reader of openReaders()) {
		if (isFullReader(reader) && isPDFReader(reader)) {
			watchReader(reader);
		}
	}
	log('started');
}

async function onMainWindowLoad({ window: win }, reason) {
	bindKeys(win, win);
}

async function onMainWindowUnload({ window: win }, reason) {
	unbindKeys(win);
	for (let i = _uiDocs.length - 1; i >= 0; i--) {
		if (_uiDocs[i].chromeWin === win) {
			_uiDocs.splice(i, 1);
		}
	}
	if (win._vrtlImmersive) {
		endImmersive(win);
	}
}

async function shutdown(data, reason) {
	if (reason === APP_SHUTDOWN) {
		return;
	}
	cleanup();
	log('shut down');
}

function cleanup() {
	try {
		Zotero.Reader.unregisterEventListener('renderToolbar', onRenderToolbar);
	}
	catch (e) {}
	if (_notifierID) {
		try {
			Zotero.Notifier.unregisterObserver(_notifierID);
		}
		catch (e) {}
		_notifierID = null;
	}
	if (_pluginsObserver) {
		try {
			Zotero.Plugins.removeObserver(_pluginsObserver);
		}
		catch (e) {}
		_pluginsObserver = null;
	}
	for (let t of _timers) {
		clearTimeout(t);
	}
	_timers = [];
	for (let reader of openReaders()) {
		try {
			let win = viewerWindowOf(reader);
			if (_prevSpread.has(reader)) {
				applyRTL(reader, false);
			}
			else {
				setRTLStyle(win, false);
			}
		}
		catch (e) {}
	}
	for (let win of _immersiveWindows.slice()) {
		try {
			endImmersive(win);
		}
		catch (e) {}
	}
	for (let entry of _uiDocs) {
		try {
			for (let id of [BTN_RTL, BTN_FULL]) {
				let node = entry.doc.getElementById(id);
				if (node) {
					node.remove();
				}
			}
			toggleStyle(entry.doc, STYLE_UI, null);
		}
		catch (e) {}
	}
	_uiDocs = [];
	for (let l of _listeners) {
		try {
			l.target.removeEventListener('keydown', l.listener, true);
		}
		catch (e) {}
	}
	_listeners = [];
}

// ---------------------------------------------------------------- 定位阅读器

function openReaders() {
	try {
		return Zotero.Reader._readers.slice();
	}
	catch (e) {
		return [];
	}
}

/**
 * renderToolbar 事件带回来的 reader 是被 Proxy 包住的原始实例：`new ReaderTab()`
 * 返回代理、_readers 里存代理，但方法内的 this 是代理的目标，两个对象身份不同。
 * WeakMap 和 includes 都靠身份，所以入口先换成注册表里的句柄，保证全局只用一个键。
 */
function chromeReader(reader) {
	if (!reader) {
		return null;
	}
	let internal = null;
	try {
		internal = reader._internalReader;
	}
	catch (e) {}
	if (!internal) {
		return reader;
	}
	let found = openReaders().find((r) => {
		try {
			return r._internalReader === internal;
		}
		catch (e) {
			return false;
		}
	});
	return found || reader;
}

/**
 * pdf.js viewer 的窗口；EPUB / 快照 / 尚未就绪时返回 null。
 */
function viewerWindowOf(reader) {
	try {
		let view = reader._internalReader && reader._internalReader._primaryView;
		let win = view && view._iframeWindow;
		if (!win || !win.PDFViewerApplication || !win.PDFViewerApplication.pdfViewer) {
			return null;
		}
		if (!win.document.getElementById('viewerContainer')) {
			return null;
		}
		return win;
	}
	catch (e) {
		return null;
	}
}

/**
 * 只处理正式打开的阅读器（标签页或独立窗口），跳过条目面板里的附件预览。
 */
function isFullReader(reader) {
	try {
		if (reader.tabID) {
			return true;
		}
		let win = reader._window;
		return !!(win && win.document && win.document.documentElement.id === 'pdf-reader');
	}
	catch (e) {
		return false;
	}
}

function isPDFReader(reader) {
	let type = null;
	try {
		type = reader.type || reader._type;
	}
	catch (e) {}
	return type === 'pdf';
}

function activeReader(win) {
	try {
		if (win.reader) {
			return win.reader;
		}
		if (win.Zotero_Tabs) {
			let selectedID = win.Zotero_Tabs.selectedID;
			if (Zotero.Reader.getByTabID) {
				return Zotero.Reader.getByTabID(selectedID) || null;
			}
			return openReaders().find((r) => r.tabID === selectedID) || null;
		}
	}
	catch (e) {}
	return null;
}

// ---------------------------------------------------------------- 竖排

function rtlEnabled() {
	return !!Zotero.Prefs.get(PREF_RTL);
}

function setRTLStyle(win, on) {
	if (!win) return;
	toggleStyle(win.document, STYLE_RTL, on ? CSS_RTL : null);
}

/**
 * @param reader Zotero.Reader 的 ReaderInstance
 * @param on 是否启用竖排
 * @returns viewer 是否已就绪
 */
function applyRTL(reader, on) {
	let win = viewerWindowOf(reader);
	if (!win) {
		return false;
	}
	setRTLStyle(win, on);
	let viewer = win.PDFViewerApplication.pdfViewer;
	let spread = viewer.spreadMode;   // -1 unknown / 0 none / 1 odd / 2 even
	if (on) {
		if (spread === 0 || spread === -1) {
			if (!_prevSpread.has(reader)) {
				_prevSpread.set(reader, spread === -1 ? 0 : spread);
			}
			// 走 Zotero 自己的通道，视图状态落盘和菜单勾选条都会跟上
			setSpreadMode(reader, 1);
		}
	}
	else if ((spread === 1 || spread === 2) && _prevSpread.has(reader)) {
		setSpreadMode(reader, _prevSpread.get(reader));
		_prevSpread.delete(reader);
	}
	return true;
}

function setSpreadMode(reader, value) {
	// 直接写到 internal reader 的 setter（它再走 pdf.js 的 switchspreadmode 事件），
	// 与 Zotero 「视图 → 奇数页对开」菜单同一条链路，视图状态落盘和菜单勾选条都会跟上
	try {
		reader._internalReader.spreadMode = value;
	}
	catch (e) {
		Zotero.logError(e);
	}
}

function setRTL(on) {
	Zotero.Prefs.set(PREF_RTL, on);
	let applied = 0;
	for (let reader of openReaders()) {
		if (!isFullReader(reader) || !isPDFReader(reader)) {
			continue;
		}
		if (applyRTL(reader, on)) {
			applied++;
		}
		else {
			watchReader(reader);   // 还在加载，等它就绪后再贴
		}
	}
	refreshUI();
	log('RTL ' + (on ? 'on' : 'off') + '，已应用 ' + applied + ' 个阅读器');
}

/**
 * viewer 文档每次打开附件都是新建的，所以要等到就绪再贴样式；
 * 并订阅 documentinit —— Zotero 自己的监听器先跑（从 .zotero-reader-state 恢复视图状态），
 * 我们后跑，最后一次写入生效。
 */
function watchReader(reader) {
	if (_watching.has(reader)) {
		return;   // 已经在轮询了
	}
	_watching.add(reader);
	let tries = 0;
	let done = () => {
		_watching.delete(reader);
	};
	let tick = () => {
		if (!openReaders().includes(reader)) {
			done();
			return;   // 阅读器已经关了
		}
		let win = viewerWindowOf(reader);
		if (win) {
			done();
			onViewerReady(reader, win);
			return;
		}
		if (++tries > 40) {
			done();
			log('viewer 未就绪，放弃：' + reader.tabID);
			return;
		}
		_timers.push(setTimeout(tick, 500));
	};
	tick();
}

function onViewerReady(reader, win) {
	let view = reader._internalReader._primaryView;
	bindKeys(win, reader._window);
	applyRTL(reader, rtlEnabled());
	if (!view || _initHooked.has(view)) {
		return;
	}
	_initHooked.add(view);
	// Zotero 恢复视图状态（包括 spreadMode）发生在 pdf.js 的 documentinit 里，
	// 而 PDFView.initializedPromise 是在那之后才 resolve 的 —— 在它之后补一次，
	// 保证我们的对开设置不会被存档反向覆盖。
	if (view.initializedPromise) {
		view.initializedPromise
			.then(() => {
				applyRTL(reader, rtlEnabled());
				refreshUI();
			})
			.catch((e) => Zotero.logError(e));
	}
	else {
		// 拿不到 initializedPromise 时兜底：等视图状态恢复完再补一次
		_timers.push(setTimeout(() => {
			applyRTL(reader, rtlEnabled());
			refreshUI();
		}, 600));
	}
}

// ---------------------------------------------------------------- 沉浸式全屏

function toggleImmersive(win) {
	if (!win) {
		return;
	}
	if (win._vrtlImmersive) {
		endImmersive(win);
	}
	else if (activeReader(win)) {
		// 当前标签不是阅读器时不进入，免得菜单和标签栏一起没了
		beginImmersive(win);
	}
	else {
		log('忽略：当前标签不是阅读器');
	}
	refreshUI();
}

function beginImmersive(win) {
	toggleStyle(win.document, STYLE_IMM, CSS_IMM);
	let root = win.document.documentElement;
	if (!win._vrtlSizemode) {
		win._vrtlSizemode = root.getAttribute('sizemode') || 'normal';
	}
	if (win._vrtlSizemode !== 'maximized' && typeof win.maximize === 'function') {
		try {
			win.maximize();
		}
		catch (e) {}
	}
	win._vrtlImmersive = true;
	if (!_immersiveWindows.includes(win)) {
		_immersiveWindows.push(win);
	}
}

function endImmersive(win) {
	toggleStyle(win.document, STYLE_IMM, null);
	if (win._vrtlImmersive && win._vrtlSizemode === 'normal' && typeof win.restore === 'function') {
		try {
			win.restore();
		}
		catch (e) {}
	}
	win._vrtlImmersive = false;
	_immersiveWindows = _immersiveWindows.filter((w) => w !== win);
}

// ---------------------------------------------------------------- 样式 / 快捷键 / 按钮

function toggleStyle(doc, id, css) {
	if (!doc) return;
	let node = doc.getElementById(id);
	if (css) {
		if (node) {
			node.textContent = css;
			return;
		}
		node = doc.createElement('style');
		node.id = id;
		node.textContent = css;
		(doc.head || doc.documentElement).appendChild(node);
	}
	else if (node) {
		node.remove();
	}
}

function bindKeys(target, chromeWin) {
	if (!target || _wired.has(target)) {
		return;
	}
	_wired.add(target);
	let listener = (event) => handleKey(event, chromeWin);
	try {
		target.addEventListener('keydown', listener, true);
		_listeners.push({ target: target, listener: listener });
	}
	catch (e) {
		Zotero.logError(e);
	}
}

function unbindKeys(target) {
	for (let i = _listeners.length - 1; i >= 0; i--) {
		if (_listeners[i].target === target) {
			try {
				target.removeEventListener('keydown', _listeners[i].listener, true);
			}
			catch (e) {}
			_listeners.splice(i, 1);
		}
	}
}

function handleKey(event, chromeWin) {
	if (event.repeat || !chromeWin || event.altKey) {
		return;
	}
	let key = event.key;
	if (key === 'F11') {
		event.preventDefault();
		event.stopPropagation();
		if (oncePerBurst('immersive')) {
			toggleImmersive(chromeWin);
		}
		return;
	}
	let mod = Zotero.isMac ? event.metaKey : event.ctrlKey;
	if (mod && event.shiftKey && key && key.toLowerCase() === 'v') {
		// 只在当前确实是 PDF 阅读器时接管，避免抢掉笔记编辑器里的同名按键
		if (!isPDFReader(activeReader(chromeWin))) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (oncePerBurst('rtl')) {
			setRTL(!rtlEnabled());
		}
	}
}

function onRenderToolbar(event) {
	let reader = chromeReader(event.reader);
	let doc = event.doc;
	if (!reader || !doc || !isFullReader(reader) || !isPDFReader(reader)) {
		return;
	}
	toggleStyle(doc, STYLE_UI, CSS_UI);
	addButtons(event, reader);
	bindKeys(reader._iframeWindow, reader._window);
	watchReader(reader);
	refreshUI();
}

function makeButton(doc, id, label, tip, onClick) {
	let btn = doc.createElement('div');
	btn.className = 'toolbar-button vrtl-btn';
	btn.id = id;
	btn.setAttribute('role', 'button');
	btn.setAttribute('tabindex', '-1');
	btn.textContent = label;
	btn.title = tip;
	btn.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		onClick();
	});
	return btn;
}

function addButtons(event, reader) {
	let doc = event.doc;
	let chromeWin = reader._window;
	if (!doc.getElementById(BTN_RTL)) {
		event.append(makeButton(doc, BTN_RTL, '竖排',
			'竖排对开（页序右→左）\nCtrl+Shift+V', () => setRTL(!rtlEnabled())));
	}
	if (!doc.getElementById(BTN_FULL)) {
		event.append(makeButton(doc, BTN_FULL, '全屏',
			'沉浸式全屏：隐藏 Zotero 界面，批注工具栏保留\nF11', () => toggleImmersive(chromeWin)));
	}
	if (!_uiDocs.some((x) => x.doc === doc)) {
		_uiDocs.push({ doc: doc, chromeWin: chromeWin });
	}
}

function refreshUI() {
	let rtl = rtlEnabled();
	for (let i = _uiDocs.length - 1; i >= 0; i--) {
		let entry = _uiDocs[i];
		try {
			let rtlBtn = entry.doc.getElementById(BTN_RTL);
			let fullBtn = entry.doc.getElementById(BTN_FULL);
			if (!rtlBtn && !fullBtn) {
				_uiDocs.splice(i, 1);   // React 重渲染把节点擦掉了，下次 renderToolbar 再挂
				continue;
			}
			if (rtlBtn) {
				rtlBtn.classList.toggle('active', rtl);
				rtlBtn.setAttribute('aria-pressed', rtl ? 'true' : 'false');
			}
			if (fullBtn) {
				let on = !!(entry.chromeWin && entry.chromeWin._vrtlImmersive);
				fullBtn.classList.toggle('active', on);
				fullBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
			}
		}
		catch (e) {
			_uiDocs.splice(i, 1);
		}
	}
}
