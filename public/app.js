// --- Sound Files ---
const SOUND_JOIN = '/sounds/join.mp3';
const SOUND_LEAVE = '/sounds/disconnect.mp3';

// --- Globals ---
let socket;
let myPeer;
let myStream;
let localScreenStream = null; // Screen share stream
let audioMixerContext = null; // Audio Mixer Context
let mixedAudioStream = null;  // Mixed Stream (Mic + System)
let availableRooms = [];
let myNickname = "Misafir";
let currentRoomName = '';
let soundsEnabled = true;
let noiseSuppressionEnabled = true;
let isListener = false;
const nicknames = {};
const activeCalls = {}; // Keep track of active MediaConnections
let currentScreenSharerId = null; // Track who is sharing screen
let activeKickVote = null;
let myAvatarSet = 'set1';
let myAvatarBg = 'bg1';
const userAvatarStyles = {}; // { peerId: { set, bg } }

let i18nUnavailableWarned = false;
const t = (key, params) => {
    if (window.i18next && typeof window.i18next.t === 'function') return window.i18next.t(key, params);
    if (!i18nUnavailableWarned) {
        console.warn('i18next is not available; translation keys will be shown instead of localized text.');
        i18nUnavailableWarned = true;
    }
    return key;
};

// --- Avatar Helpers ---
function getAvatarUrl(name, size, peerId) {
    const cleanName = encodeURIComponent(name);
    let set = myAvatarSet;
    let bg = myAvatarBg;
    if (peerId && peerId !== (myPeer && myPeer.id)) {
        const style = userAvatarStyles[peerId];
        if (style) { set = style.set; bg = style.bg; }
    }
    const bgParam = bg !== 'none' ? `&bgset=${bg}` : '';
    return `https://robohash.org/${cleanName}?set=${set}&size=${size}${bgParam}`;
}

function showAvatarPicker() {
    return new Promise((resolve) => {
        const backdrop = document.getElementById('avatar-picker-backdrop');
        if (!backdrop) { resolve(null); return; }

        const SETS = [
            { id: 'set1', label: '🤖', key: 'ui.avatarPicker.robots' },
            { id: 'set2', label: '👾', key: 'ui.avatarPicker.monsters' },
            { id: 'set3', label: '🗣️', key: 'ui.avatarPicker.heads' },
            { id: 'set4', label: '🐱', key: 'ui.avatarPicker.kittens' },
            { id: 'set5', label: '🧑', key: 'ui.avatarPicker.humans' },
        ];
        const BGS = [
            { id: 'none', key: 'ui.avatarPicker.bgNone' },
            { id: 'bg1', key: 'ui.avatarPicker.bg1' },
            { id: 'bg2', key: 'ui.avatarPicker.bg2' },
        ];

        let selectedSet = myAvatarSet;
        let selectedBg = myAvatarBg;

        const titleEl = document.getElementById('avatar-picker-title');
        if (titleEl) titleEl.textContent = t('ui.avatarPicker.title');

        function buildPreviewUrl() {
            const name = (document.getElementById('nickname-input')?.value?.trim()) || myNickname || 'Guest';
            const cleanName = encodeURIComponent(name);
            const bgParam = selectedBg !== 'none' ? `&bgset=${selectedBg}` : '';
            return `https://robohash.org/${cleanName}?set=${selectedSet}&size=150x150${bgParam}`;
        }

        let setButtons = [];
        let bgButtons = [];

        function buildButtons() {
            const setsContainer = document.getElementById('avatar-picker-sets');
            setsContainer.innerHTML = '';
            setButtons = SETS.map(s => {
                const btn = document.createElement('button');
                btn.className = 'avatar-option-btn';
                btn.textContent = `${s.label} ${t(s.key)}`;
                btn.onclick = () => { selectedSet = s.id; updateSelection(); };
                setsContainer.appendChild(btn);
                return { btn, id: s.id };
            });

            const bgsContainer = document.getElementById('avatar-picker-bgs');
            bgsContainer.innerHTML = '';
            bgButtons = BGS.map(b => {
                const btn = document.createElement('button');
                btn.className = 'avatar-option-btn';
                btn.textContent = t(b.key);
                btn.onclick = () => { selectedBg = b.id; updateSelection(); };
                bgsContainer.appendChild(btn);
                return { btn, id: b.id };
            });
        }

        function updateSelection() {
            const preview = document.getElementById('avatar-picker-preview');
            if (preview) preview.src = buildPreviewUrl();
            setButtons.forEach(({ btn, id }) => btn.classList.toggle('selected', id === selectedSet));
            bgButtons.forEach(({ btn, id }) => btn.classList.toggle('selected', id === selectedBg));
        }

        buildButtons();
        updateSelection();
        backdrop.style.display = 'flex';

        const confirmBtn = document.getElementById('avatar-picker-confirm');
        const cancelBtn = document.getElementById('avatar-picker-cancel');

        function cleanup() {
            backdrop.style.display = 'none';
            confirmBtn.onclick = null;
            cancelBtn.onclick = null;
        }

        confirmBtn.onclick = () => {
            myAvatarSet = selectedSet;
            myAvatarBg = selectedBg;
            cleanup();
            updateLoginAvatarPreview();
            resolve({ set: selectedSet, bg: selectedBg });
        };
        cancelBtn.onclick = () => {
            cleanup();
            resolve(null);
        };
    });
}

function updateLoginAvatarPreview() {
    const preview = document.getElementById('login-avatar-preview');
    if (!preview) return;
    const name = (document.getElementById('nickname-input')?.value?.trim()) || 'Guest';
    const cleanName = encodeURIComponent(name);
    const bgParam = myAvatarBg !== 'none' ? `&bgset=${myAvatarBg}` : '';
    preview.src = `https://robohash.org/${cleanName}?set=${myAvatarSet}&size=80x80${bgParam}`;
}

function updateRoomDisplay() {
    const roomDisplay = document.getElementById('room-display');
    if (roomDisplay) roomDisplay.innerText = `${t('ui.roomPrefix')}: ${currentRoomName || '...'}`;
}

function renderRoomOptions() {
    const select = document.getElementById('room-select');
    if (!select) return;
    const selectedValue = select.value;
    select.innerHTML = '';
    availableRooms.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.innerText = r.isLocked ? `🔒 ${r.name}` : r.name;
        select.appendChild(opt);
    });
    if (selectedValue && availableRooms.some(r => r.id === selectedValue)) {
        select.value = selectedValue;
    } else if (availableRooms.length > 0) {
        select.value = availableRooms[0].id;
    }
    select.style.display = availableRooms.length === 1 ? 'none' : 'block';
    checkRoomLock();
}

function applyTranslations() {
    if (!window.i18next) return;
    document.documentElement.lang = window.i18next.resolvedLanguage || 'tr';
    document.title = t('app.title');
    document.getElementById('https-warning').innerText = t('ui.httpsWarning');
    document.getElementById('notification-toast').innerText = t('ui.micDetected');
    document.getElementById('vote-text').innerText = t('ui.voteTitleDefault');
    document.getElementById('vote-subtext').innerText = t('ui.voteSubtext');
    document.getElementById('vote-yes-btn').innerText = t('ui.yes');
    document.getElementById('vote-no-btn').innerText = t('ui.no');
    document.getElementById('vote-status').innerText = t('ui.voteWaiting');
    document.getElementById('login-title').innerText = `🎙️ ${t('ui.loginTitle')}`;
    document.getElementById('nickname-input').placeholder = t('ui.nicknamePlaceholder');
    document.getElementById('password-input').placeholder = t('ui.passwordPlaceholder');
    document.getElementById('join-btn').innerText = t('ui.joinRoom');
    document.getElementById('notification-sounds-label').innerText = t('ui.notificationSounds');
    document.getElementById('noise-suppression-label').innerText = t('ui.noiseSuppression');
    document.getElementById('sound-toggle-main-label').title = t('ui.entrySounds');
    document.getElementById('btn-share-screen-header').innerText = t('ui.shareScreen');
    document.getElementById('btn-share-screen-header').title = t('ui.shareScreen');
    document.getElementById('my-mute-btn').innerText = t('ui.mute');
    document.getElementById('leave-btn').innerText = t('ui.leave');
    document.getElementById('screen-stage-label').innerText = t('ui.screenShareStage');
    document.getElementById('fullscreen-btn').innerText = t('ui.fullscreen');
    document.getElementById('chat-tab-btn').innerText = t('ui.tabs.chat');
    document.getElementById('participants-tab-label').innerText = t('ui.tabs.participants');
    document.getElementById('reactions-tab-btn').innerText = t('ui.tabs.reactions');
    document.getElementById('message-input').placeholder = t('ui.messagePlaceholder');
    document.getElementById('send-btn').innerText = t('ui.send');
    document.getElementById('notification-toast').setAttribute('aria-label', t('ui.aria.micDetectedAction'));
    document.getElementById('nickname-input').setAttribute('aria-label', t('ui.aria.nicknameInput'));
    document.getElementById('room-select').setAttribute('aria-label', t('ui.aria.roomSelect'));
    document.getElementById('password-input').setAttribute('aria-label', t('ui.aria.passwordInput'));
    document.getElementById('join-btn').setAttribute('aria-label', t('ui.aria.joinRoom'));
    document.getElementById('sound-toggle-login').setAttribute('aria-label', t('ui.aria.notificationSounds'));
    document.getElementById('noise-suppression-toggle').setAttribute('aria-label', t('ui.aria.noiseSuppression'));
    document.getElementById('language-select').setAttribute('aria-label', t('ui.aria.languageSelect'));
    document.getElementById('sound-toggle-main').setAttribute('aria-label', t('ui.aria.entrySounds'));
    document.getElementById('btn-share-screen-header').setAttribute('aria-label', t('ui.aria.shareScreen'));
    document.getElementById('my-mute-btn').setAttribute('aria-label', t('ui.aria.toggleMute'));
    document.getElementById('leave-btn').setAttribute('aria-label', t('ui.aria.leaveRoom'));
    document.getElementById('fullscreen-btn').setAttribute('aria-label', t('ui.aria.fullscreen'));
    document.getElementById('chat-tab-btn').setAttribute('aria-label', t('ui.aria.tabChat'));
    document.getElementById('participants-tab-btn').setAttribute('aria-label', t('ui.aria.tabParticipants'));
    document.getElementById('reactions-tab-btn').setAttribute('aria-label', t('ui.aria.tabReactions'));
    document.getElementById('message-input').setAttribute('aria-label', t('ui.aria.messageInput'));
    document.getElementById('send-btn').setAttribute('aria-label', t('ui.aria.sendMessage'));
    const nicknameInput = document.getElementById('nickname-input');
    if (nicknameInput && nicknameInput.dataset.userEdited !== 'true') {
        nicknameInput.value = t('ui.defaultGuest');
    }
    const select = document.getElementById('room-select');
    if (select && select.options.length <= 1) {
        select.innerHTML = `<option value="" disabled selected>${t('ui.roomLoading')}</option>`;
    }
    updateRoomDisplay();
    // Avatar picker labels
    const pickerTitle = document.getElementById('avatar-picker-title');
    if (pickerTitle) pickerTitle.textContent = t('ui.avatarPicker.title');
    const styleLabel = document.getElementById('avatar-picker-style-label');
    if (styleLabel) styleLabel.textContent = t('ui.avatarPicker.styleLabel');
    const bgLabel = document.getElementById('avatar-picker-bg-label');
    if (bgLabel) bgLabel.textContent = t('ui.avatarPicker.bgLabel');
    const pickerConfirm = document.getElementById('avatar-picker-confirm');
    if (pickerConfirm) pickerConfirm.textContent = t('ui.ok');
    const pickerCancel = document.getElementById('avatar-picker-cancel');
    if (pickerCancel) pickerCancel.textContent = t('ui.cancel');
    updateLoginAvatarPreview();
}

let popupResolve;
const popupQueue = [];

function showNextPopup() {
    if (popupResolve || popupQueue.length === 0) return;

    const { message, requireDecision, requireInput, defaultValue, resolve } = popupQueue.shift();
    const backdrop = document.getElementById('app-popup-backdrop');
    const msg = document.getElementById('app-popup-message');
    const okBtn = document.getElementById('app-popup-ok-btn');
    const cancelBtn = document.getElementById('app-popup-cancel-btn');
    const input = document.getElementById('app-popup-input');

    msg.textContent = message;
    okBtn.innerText = t('ui.ok');
    cancelBtn.innerText = t('ui.cancel');
    cancelBtn.style.display = requireDecision ? 'inline-block' : 'none';
    input.style.display = requireInput ? 'block' : 'none';
    input.placeholder = t('ui.nicknamePlaceholder');
    input.value = requireInput ? (defaultValue || '') : '';
    if (requireInput) {
        input.onkeydown = (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                closeAppPopup(true);
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                closeAppPopup(false);
            }
        };
    }

    popupResolve = resolve;
    okBtn.onclick = () => closeAppPopup(true);
    cancelBtn.onclick = () => closeAppPopup(false);
    backdrop.style.display = 'flex';
    if (requireInput) setTimeout(() => input.focus(), 0);
}

function closeAppPopup(result) {
    const backdrop = document.getElementById('app-popup-backdrop');
    const input = document.getElementById('app-popup-input');
    const inputVisible = input.style.display !== 'none';
    backdrop.style.display = 'none';
    let popupResult = result;
    if (inputVisible) {
        popupResult = result ? input.value : null;
    }
    if (popupResolve) popupResolve(popupResult);
    input.style.display = 'none';
    input.value = '';
    popupResolve = null;
    showNextPopup();
}

function showAppPopup(message, requireDecision = false, options = {}) {
    return new Promise(resolve => {
        popupQueue.push({
            message,
            requireDecision,
            requireInput: Boolean(options.requireInput),
            defaultValue: options.defaultValue || '',
            resolve
        });
        showNextPopup();
    });
}

function showAppAlert(message) {
    return showAppPopup(message);
}

function showAppConfirm(message) {
    return showAppPopup(message, true);
}

function showAppPrompt(message, defaultValue = '') {
    return showAppPopup(message, true, { requireInput: true, defaultValue });
}

// --- Init ---
window.onload = async function () {
    if (!window.i18next || !window.i18nextHttpBackend || !window.i18nextBrowserLanguageDetector) {
        console.error('Required i18next libraries failed to load. Please refresh the page or check your connection.');
        return;
    }
    await window.i18next
        .use(window.i18nextHttpBackend)
        .use(window.i18nextBrowserLanguageDetector)
        .init({
            fallbackLng: 'tr',
            supportedLngs: ['tr', 'en', 'es'],
            load: 'languageOnly',
            // Translation files are served from /i18n/{lng}.json
            backend: { loadPath: '/i18n/{lng}.json' },
            detection: {
                order: ['localStorage', 'navigator'],
                lookupLocalStorage: 'ovc-lang',
                caches: ['localStorage']
            },
            interpolation: { escapeValue: true, prefix: '{', suffix: '}' }
        });
    const languageSelect = document.getElementById('language-select');
    languageSelect.value = window.i18next.resolvedLanguage || 'tr';
    const notificationToast = document.getElementById('notification-toast');
    if (notificationToast) {
        notificationToast.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                window.location.reload();
            }
        });
    }
    const tabs = Array.from(document.querySelectorAll('.chat-tab'));
    tabs.forEach((tab, index) => {
        tab.addEventListener('keydown', (event) => {
            let nextIndex = null;
            if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
            if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
            if (event.key === 'Home') nextIndex = 0;
            if (event.key === 'End') nextIndex = tabs.length - 1;
            if (nextIndex === null) return;
            event.preventDefault();
            tabs[nextIndex].focus();
            tabs[nextIndex].click();
        });
    });
    const nicknameInput = document.getElementById('nickname-input');
    if (nicknameInput) {
        nicknameInput.addEventListener('input', () => {
            nicknameInput.dataset.userEdited = 'true';
            updateLoginAvatarPreview();
        });
    }
    languageSelect.addEventListener('change', async (event) => {
        await window.i18next.changeLanguage(event.target.value);
        applyTranslations();
        renderRoomOptions();
        updateParticipantsList();
        if (localScreenStream && myPeer) {
            const stageLabel = document.getElementById('screen-stage-label');
            stageLabel.innerText = t('ui.stageSharing', { name: myNickname });
        }
    });
    applyTranslations();

    // HTTPS/Localhost Kontrolü
    if (!window.isSecureContext) {
        document.getElementById('https-warning').style.display = 'block';
        document.getElementById('join-btn').disabled = true;
        return;
    }

    const t1 = document.getElementById('sound-toggle-login');
    const t2 = document.getElementById('sound-toggle-main');
    if (t1) t1.addEventListener('change', (e) => { soundsEnabled = e.target.checked; if (t2) t2.checked = e.target.checked; });
    if (t2) t2.addEventListener('change', (e) => { soundsEnabled = e.target.checked; if (t1) t1.checked = e.target.checked; });

    const nsToggle = document.getElementById('noise-suppression-toggle');
    if (nsToggle) nsToggle.addEventListener('change', (e) => { noiseSuppressionEnabled = e.target.checked; });

    try {
        const res = await fetch('/rooms');
        availableRooms = await res.json();
        renderRoomOptions();
    } catch (e) { console.error("Odalar yüklenemedi", e); }

    // Device Change Listener (Hot-plugging)
    navigator.mediaDevices.ondevicechange = async () => {
        if (isListener) {
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const hasMic = devices.some(d => d.kind === 'audioinput');
                if (hasMic) {
                    document.getElementById('notification-toast').style.display = 'block';
                }
            } catch (e) { console.warn(e); }
        }
    };
};

function syncSoundToggle(el) {
    soundsEnabled = el.checked;
    const loginToggle = document.getElementById('sound-toggle-login');
    if (loginToggle) loginToggle.checked = el.checked;
}

// --- Tab Switching ---
function switchTab(tabName, sourceButton = null) {
    const tabButtons = document.querySelectorAll('.chat-tab');
    // Update tab buttons
    tabButtons.forEach(tab => {
        tab.classList.remove('active');
        tab.setAttribute('aria-selected', 'false');
    });
    const activeButton = sourceButton || document.getElementById(`${tabName}-tab-btn`);
    if (activeButton) {
        activeButton.classList.add('active');
        activeButton.setAttribute('aria-selected', 'true');
    }

    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
        content.hidden = true;
    });

    if (tabName === 'chat') {
        const panel = document.getElementById('chat-tab-content');
        panel.classList.add('active');
        panel.hidden = false;
    } else if (tabName === 'participants') {
        const panel = document.getElementById('participants-tab-content');
        panel.classList.add('active');
        panel.hidden = false;
    } else if (tabName === 'reactions') {
        const panel = document.getElementById('reactions-tab-content');
        panel.classList.add('active');
        panel.hidden = false;
    }
}

// --- Reactions Management ---
let currentReactionAudio = null; // Track currently playing reaction

async function loadReactions() {
    try {
        const language = (i18next.language || 'en').split('-')[0];
        const response = await fetch(`/api/reactions?lang=${encodeURIComponent(language)}`);
        const reactions = await response.json();

        const list = document.getElementById('reactions-list');
        list.innerHTML = '';

        if (reactions.length === 0) {
            list.innerHTML = `<div style="text-align:center; color:#666; padding:20px;">${t('ui.reactionsEmpty')}</div>`;
            return;
        }

        reactions.forEach(reaction => {
            const btn = document.createElement('button');
            btn.className = 'reaction-btn';
            btn.textContent = reaction.name;
            btn.title = reaction.name;
            btn.onclick = () => playReaction(reaction.url, reaction.name);
            list.appendChild(btn);
        });
    } catch (err) {
        console.error('Error loading reactions:', err);
    }
}

function playReaction(url, name) {
    if (!socket) return;

    // Send to server to broadcast to everyone
    socket.emit('play-reaction', url);
}

function playReactionSound(url, userName) {
    try {
        // Stop currently playing reaction if exists
        if (currentReactionAudio) {
            currentReactionAudio.pause();
            currentReactionAudio.currentTime = 0;
            currentReactionAudio = null;
        }

        // Create and play new audio
        const audio = new Audio(url);
        audio.volume = 0.7;
        currentReactionAudio = audio;

        // Clear reference when audio ends
        audio.onended = () => {
            if (currentReactionAudio === audio) {
                currentReactionAudio = null;
            }
        };

        audio.play().catch(e => console.log("Reaction play blocked", e));

    } catch (err) {
        console.error('Error playing reaction:', err);
    }
}

// --- Participant List Management ---
function updateParticipantsList() {
    const list = document.getElementById('participants-list');
    const count = document.getElementById('participant-count');

    list.innerHTML = '';
    const participantCount = Object.keys(nicknames).length;
    count.textContent = participantCount;

    // Add self first
    if (myPeer && myPeer.id) {
        const avatarUrl = getAvatarUrl(myNickname, '40x40');
        const isSharing = localScreenStream !== null;

        const item = document.createElement('div');
        item.className = 'participant-item';
        item.innerHTML = `
            <img src="${avatarUrl}" class="participant-avatar" alt="Avatar">
            <div class="participant-info">
                <div class="participant-name">${myNickname} ${isSharing ? '🖥️' : ''}</div>
                <div class="participant-status">${isListener ? t('ui.participantStatus.listener') : t('ui.participantStatus.speaking')}</div>
            </div>
            <span class="participant-badge">${t('ui.youBadge')}</span>
        `;
        list.appendChild(item);
    }

    // Add other participants
    Object.entries(nicknames).forEach(([peerId, name]) => {
        if (myPeer && peerId === myPeer.id) return; // Skip self

        const avatarUrl = getAvatarUrl(name, '40x40', peerId);
        const isSharing = currentScreenSharerId === peerId;

        const item = document.createElement('div');
        item.className = 'participant-item';
        item.innerHTML = `
            <img src="${avatarUrl}" class="participant-avatar" alt="Avatar">
            <div class="participant-info">
                <div class="participant-name">${name} ${isSharing ? '🖥️' : ''}</div>
                <div class="participant-status">${t('ui.participantStatus.connected')}</div>
            </div>
        `;
        list.appendChild(item);
    });
}

function playSound(type) {
    if (!soundsEnabled) return;
    try {
        const audio = new Audio(type === 'join' ? SOUND_JOIN : SOUND_LEAVE);
        audio.volume = 0.5; // Increased volume for better audibility
        audio.play().catch(e => console.log("Audio play blocked", e));
    } catch (e) { console.error(e); }
}

function checkRoomLock() {
    const rid = document.getElementById('room-select').value;
    const r = availableRooms.find(x => x.id === rid);
    document.getElementById('password-input').style.display = (r && r.isLocked) ? 'block' : 'none';
}

// --- Core Logic ---
async function startApp() {
    myNickname = document.getElementById('nickname-input').value.trim() || t('ui.defaultGuest');
    const roomId = document.getElementById('room-select').value;
    const password = document.getElementById('password-input').value;

    if (!roomId) return showAppAlert(t('ui.selectRoom'));

    const joinBtn = document.getElementById('join-btn');
    joinBtn.innerText = t('ui.connecting');
    joinBtn.disabled = true;

    try {
        // MİKROFONU DENE
        myStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                noiseSuppression: noiseSuppressionEnabled,
                echoCancellation: noiseSuppressionEnabled,
                autoGainControl: noiseSuppressionEnabled
            }
        });
        isListener = false;
    } catch (err) {
        console.warn("Mikrofon hatası:", err);

        // Eğer mikrofon bulunamazsa (NotFoundError) veya erişim reddedilirse
        const proceed = await showAppConfirm(t('ui.micErrorConfirm', { error: err.name }));

        if (proceed) {
            // Boş (Sessiz) bir ses kanalı oluştur (Dummy Stream)
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = ctx.createOscillator();
            const dest = ctx.createMediaStreamDestination();
            oscillator.connect(dest);
            myStream = dest.stream;
            myStream.getAudioTracks()[0].enabled = false;
            isListener = true;
            // Hide Mute Btn
            document.getElementById('my-mute-btn').style.display = 'none';
        } else {
            joinBtn.disabled = false;
            joinBtn.innerText = t('ui.joinRoom');
            return;
        }
    }

    try {
        const isSecure = window.location.protocol === 'https:';
        myPeer = new Peer(undefined, {
            host: window.location.hostname,
            port: isSecure ? 443 : 3000,
            path: '/peerjs',
            secure: isSecure
        });

        myPeer.on('open', id => initSocket(roomId, id, password));

        myPeer.on('call', call => {
            // Answer with our current stream (Audio only OR Audio+Screen)
            const streamToAnswer = localScreenStream ? localScreenStream : myStream;
            call.answer(streamToAnswer);

            // Register call
            activeCalls[call.peer] = call;

            call.on('stream', stream => {
                const name = nicknames[call.peer] || t('ui.defaultGuest');
                addUser(stream, call.peer, name);
            });

            // When call closes, we might NOT want to remove the user card if they are just renegotiating
            call.on('close', () => {
                // We do NOT remove user card here automatically anymore, 
                // because we might be just switching streams.
                // We clean up video elements though.
                const videoEl = document.getElementById(`video-${call.peer}`);
                if (videoEl) videoEl.style.display = 'none';
                const avatarEl = document.getElementById(`avatar-${call.peer}`);
                if (avatarEl) avatarEl.style.display = 'block';
            });

            call.on('error', (err) => {
                console.error("Call error:", err);
            });
        });

        myPeer.on('error', e => {
            console.error("Peer Error", e);
            if (e.type !== 'peer-unavailable') showAppAlert(t('ui.connectionError', { error: e.type }));
        });

    } catch (err) {
        await showAppAlert(t('ui.connectionStartFailed', { error: err.message }));
        joinBtn.disabled = false;
        joinBtn.innerText = t('ui.joinRoom');
    }
}

function initSocket(roomId, id, password) {
    socket = io('/', {
        transports: ['polling', 'websocket'], // Fix: Polling first is more stable behind proxies
        reconnectionAttempts: 5,
        timeout: 10000
    });
    socket.emit('join-room', { roomId, peerId: id, nickname: myNickname, password, avatarStyle: { set: myAvatarSet, bg: myAvatarBg } });

    socket.on('joined-room', (data) => {
        // Handle new object payload or legacy string
        let rId = data;
        if (typeof data === 'object') {
            rId = data.roomId;
            if (data.nickname) myNickname = data.nickname;
        }

        document.getElementById('login-overlay').style.display = 'none';
        document.getElementById('app-container').style.display = 'flex';

        const roomName = availableRooms.find(r => r.id === rId)?.name || rId;
        currentRoomName = roomName;
        updateRoomDisplay();

        // Kendi kartımızı ekle
        addUser(myStream, id, myNickname, true);

        playSound('join');
        updateParticipantsList();
        loadReactions();
    });

    socket.on('existing-users', (userList) => {
        Object.assign(nicknames, userList);
        for (const [pid, name] of Object.entries(userList)) {
            updateUserCardName(pid, name);
        }
        updateParticipantsList();
    });

    socket.on('existing-users-avatars', (avatarList) => {
        Object.assign(userAvatarStyles, avatarList);
        for (const [pid] of Object.entries(avatarList)) {
            const name = nicknames[pid];
            if (name) updateUserCardName(pid, name);
        }
        updateParticipantsList();
    });

    socket.on('error', msg => {
        const translatedError = msg === 'INVALID_PASSWORD' ? t('ui.invalidPassword') : msg;
        if (msg === 'INVALID_PASSWORD') {
            const joinBtn = document.getElementById('join-btn');
            if (joinBtn) {
                joinBtn.disabled = false;
                joinBtn.innerText = t('ui.joinRoom');
            }
            showAppAlert(t('ui.errorPrefix', { error: translatedError }));
            return;
        }
        showAppAlert(t('ui.errorPrefix', { error: translatedError })).then(() => window.location.reload());
    });

    socket.on('user-connected', (uid, name, avatarStyle) => {
        nicknames[uid] = name;
        if (avatarStyle) userAvatarStyles[uid] = avatarStyle;
        addSystemMsg(t('ui.userJoined', { name }));
        playSound('join');
        updateParticipantsList();
        // Yeni geleni biz arıyoruz
        const streamToCall = localScreenStream ? localScreenStream : myStream;
        const call = myPeer.call(uid, streamToCall);
        activeCalls[uid] = call;

        call.on('stream', s => addUser(s, uid, name));

        call.on('close', () => {
            // Same logic: don't auto remove generic user logic here
            const videoEl = document.getElementById(`video-${uid}`);
            if (videoEl) videoEl.style.display = 'none';
            const avatarEl = document.getElementById(`avatar-${uid}`);
            if (avatarEl) avatarEl.style.display = 'block';
        });
        call.on('close', () => removeUser(uid));
    });

    // --- RESTORED CHAT LISTENER ---
    socket.on('chat-message', (data) => {
        const div = document.createElement('div');
        div.className = 'message';
        const displayTime = Number.isFinite(data.timestamp)
            ? new Date(data.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
            : data.time;
        div.innerHTML = `<span class="msg-time">${displayTime}</span><span class="msg-user">${data.user}:</span> ${data.text}`;
        const box = document.getElementById('chat-messages');
        if (box) {
            box.appendChild(div);
            box.scrollTop = box.scrollHeight;
        }
    });

    socket.on('user-disconnected', uid => {
        const userName = nicknames[uid] || t('ui.defaultUser');
        addSystemMsg(t('ui.userLeft', { name: userName }));
        removeUser(uid);
        delete nicknames[uid];
        updateParticipantsList();
    });

    socket.on('user-renamed', (uid, name) => {
        nicknames[uid] = name;
        updateUserCardName(uid, name);
        if (myPeer && uid === myPeer.id) myNickname = name;
        updateParticipantsList();
    });

    socket.on('user-avatar-changed', (uid, style) => {
        userAvatarStyles[uid] = style;
        const name = nicknames[uid] || (myPeer && uid === myPeer.id ? myNickname : 'Guest');
        updateUserCardName(uid, name);
        updateParticipantsList();
    });

    // Vote Events
    socket.on('vote-started', ({ targetName, targetId, yes }) => {
        activeKickVote = { targetId, yes };
        updateKickVoteBadge();
        showVoteModal(targetName, targetId);
    });

    socket.on('vote-updated', ({ targetId, yes }) => {
        activeKickVote = { targetId, yes };
        updateKickVoteBadge();
    });

    socket.on('vote-ended', () => {
        // Close modal
        document.getElementById('vote-modal').style.display = 'none';
        activeKickVote = null;
        updateKickVoteBadge();
    });

    socket.on('kick-user', (targetId) => {
        if (myPeer && targetId === myPeer.id) {
            showAppAlert(t('ui.kickedByVote')).then(() => window.location.reload());
        }
    });

    socket.on('share-started', (sharerId) => {
        currentScreenSharerId = sharerId;
        lockShareButton(sharerId);
        updateParticipantsList();
    });

    socket.on('share-ended', () => {
        currentScreenSharerId = null;
        unlockShareButton();
        updateParticipantsList();
        // Also ensure stage is closed if logic failed elsewhere
        closeStage();
    });

    socket.on('share-approved', () => {
        startScreenShareActual();
    });

    socket.on('share-denied', () => {
        showAppAlert(t('ui.shareDenied'));
        // Reset button state
        const btn = document.getElementById('btn-share-screen-header');
        if (btn) btn.classList.remove('loading'); // If we had loading state
    });

    // Reaction Events
    socket.on('reaction-played', (data) => {
        playReactionSound(data.url, data.user);
    });
}

// --- Vote UI ---
async function startVote(targetId, targetName) {
    if (!await showAppConfirm(t('ui.kickConfirm', { name: targetName }))) return;
    socket.emit('start-vote', targetId);
}

function showVoteModal(targetName, targetId) {
    const modal = document.getElementById('vote-modal');
    const timer = document.getElementById('vote-timer');
    const buttons = document.getElementById('vote-buttons');
    const status = document.getElementById('vote-status');
    const subtext = document.getElementById('vote-subtext');

    document.getElementById('vote-text').innerText = t('ui.voteTargetQuestion', { name: targetName });

    // Checks for Target
    if (myPeer && targetId === myPeer.id) {
        buttons.style.display = 'none';
        status.style.display = 'block';
        status.innerText = t('ui.voteInProgress');
        status.style.color = 'var(--danger-color)';
    } else {
        buttons.style.display = 'flex';
        status.style.display = 'none';
    }

    // Reset UI for normal voters
    if (myPeer && targetId !== myPeer.id) {
        subtext.innerText = t('ui.voteSubtext');
    }

    modal.style.display = 'block';
    timer.style.width = '100%';

    setTimeout(() => { timer.style.width = '0%'; }, 100);
    // Modal closes on vote-ended event or timer finish via server broadcast
}

function submitVote(choice) {
    socket.emit('submit-vote', choice);
    document.getElementById('vote-buttons').style.display = 'none';
    const status = document.getElementById('vote-status');
    status.style.display = 'block';
    status.innerText = t('ui.voteWaiting');
    status.style.color = '#ccc';
}

function updateKickVoteBadge() {
    document.querySelectorAll('.kick-vote-count').forEach(el => {
        el.style.display = 'none';
    });

    if (!activeKickVote) return;
    const badge = document.getElementById(`kick-vote-count-${activeKickVote.targetId}`);
    if (!badge) return;
    badge.style.display = 'flex';
    badge.innerText = String(activeKickVote.yes || 0);
    badge.title = t('ui.kickVotesBadgeTitle', { count: activeKickVote.yes || 0 });
}

// --- Chat Functions ---
function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (text && socket) {
        socket.emit('chat-message', text);
        input.value = '';
        input.style.height = 'auto';
        input.style.overflowY = 'hidden';
        input.focus();
    }
}
function handleEnter(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}
function autoResizeInput() {
    const input = document.getElementById('message-input');
    input.style.height = 'auto';
    const maxHeight = parseInt(getComputedStyle(input).maxHeight, 10);
    if (input.scrollHeight > maxHeight) {
        input.style.height = maxHeight + 'px';
        input.style.overflowY = 'auto';
    } else {
        input.style.height = input.scrollHeight + 'px';
        input.style.overflowY = 'hidden';
    }
}
document.addEventListener('DOMContentLoaded', function() {
    const msgInput = document.getElementById('message-input');
    if (msgInput) msgInput.addEventListener('input', autoResizeInput);
});

function addSystemMsg(text) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'msg-system';
    div.innerText = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

// --- UI/Audio Functions ---
// --- UI/Audio Functions ---
function addUser(stream, uid, name, isMe = false) {
    // Check if card exists
    let card = document.getElementById(`user-card-${uid}`);

    // Handle Video Track presence
    const hasVideo = stream.getVideoTracks().length > 0;

    if (card) {
        updateUserCardName(uid, name);
        // Update media if card exists
        if (hasVideo) {
            // --- CINEMA MODE LOGIC ---
            // Instead of putting video in card, put it in STAGE
            enableStage(stream, name, uid);

            // Hide avatar in card to indicate something is happening? 
            // Or keep avatar in card but show video on stage.
            // Let's keep avatar in card essentially, but maybe add an indicator.
            document.getElementById(`avatar-${uid}`).style.opacity = '0.5';
        } else {
            // Revert to avatar logic if video stops but stream continues (unlikely with replaceTrack re-call)
            // If this user was on stage, remove them
            if (isStageActive(uid)) {
                disableStage();
            }
            document.getElementById(`avatar-${uid}`).style.opacity = '1';
        }

        // If it's AUDIO update, ensure audio element logic
        let audio = document.getElementById(`audio-${uid}`);
        if (!audio && !isMe) {
            audio = document.createElement('audio');
            audio.id = `audio-${uid}`;
            audio.autoplay = true;
            document.body.appendChild(audio);
        }
        if (audio) audio.srcObject = stream;

        return;
    }

    // --- New User Logic ---

    // Audio Element (Hidden)
    if (!isMe) {
        const audio = document.createElement('audio');
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.playsInline = true;
        audio.id = `audio-${uid}`;
        document.body.appendChild(audio);
    }

    const avatarUrl = getAvatarUrl(name, '64x64', uid);

    const grid = document.getElementById('user-grid');
    card = document.createElement('div');
    card.className = 'user-card';
    card.id = `user-card-${uid}`;

    let controlsHtml = '';
    if (!isMe) {
        controlsHtml = `
            <button class="kick-btn" title="${t('ui.kickVoteTitle')}" aria-label="${t('ui.aria.startVoteAgainst', { name })}" onclick="startVote('${uid}', '${name}')">⚠️</button>
            <div class="user-controls">
                <button class="mute-btn-small" aria-label="${t('ui.aria.toggleUserMute', { name })}" onclick="toggleUserMute('${uid}')" id="mute-btn-${uid}">🔊</button>
                <input type="range" min="0" max="1" step="0.1" value="1" aria-label="${t('ui.aria.userVolume', { name })}" oninput="setVolume('${uid}', this.value)">
            </div>
        `;
    } else {
        // Self Controls
        const statusText = isListener ? t('ui.selfStatusListener') : t('ui.selfStatus');

        // Show screen share button in header if not mobile and not listener
        const isMobile = !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia;
        if (!isListener && !isMobile) {
            const headerBtn = document.getElementById('btn-share-screen-header');
            if (headerBtn) headerBtn.style.display = 'block';
        }

        controlsHtml = `
            <button class="self-rename-btn" title="${t('ui.rename')}" aria-label="${t('ui.aria.renameSelf')}" onclick="renameSelf()">✏️</button>
            <button class="self-avatar-btn" title="${t('ui.avatarPicker.changeAvatar')}" aria-label="${t('ui.avatarPicker.changeAvatar')}" onclick="changeAvatar()">🎨</button>
            <div class="user-controls" style="justify-content:center; gap:10px; margin-top:15px;">
               <span style="font-size:12px; color:var(--muted-text-color); align-self:center;">${statusText}</span>
            </div>`;
    }

    card.innerHTML = `
        <video id="video-${uid}" class="user-video" autoplay playsinline ${isMe ? 'muted' : ''}></video>
        <img src="${avatarUrl}" class="avatar-img" alt="Avatar" id="avatar-${uid}">
        <div class="kick-vote-count" id="kick-vote-count-${uid}"></div>
        <div class="user-name" id="name-${uid}">${name}</div>
        ${controlsHtml}
    `;
    grid.appendChild(card);
    updateKickVoteBadge();

    // Apply Stream to Video if exists
    if (hasVideo) {
        enableStage(stream, name, uid);
        document.getElementById(`avatar-${uid}`).style.opacity = '0.5';
    }
}

function updateUserCardName(uid, name) {
    const nameEl = document.getElementById(`name-${uid}`);
    if (nameEl) nameEl.innerText = name;

    const avatarEl = document.getElementById(`avatar-${uid}`);
    if (avatarEl) {
        avatarEl.src = getAvatarUrl(name, '64x64', uid);
    }
}

function removeUser(uid) {
    // Robust cleanup
    const c = document.getElementById(`user-card-${uid}`);
    if (c) c.remove();

    const a = document.getElementById(`audio-${uid}`);
    if (a) {
        a.srcObject = null; // stop stream
        a.remove();
    }

    // Check Stage
    if (isStageActive(uid)) {
        disableStage();
    }

    if (activeCalls[uid]) delete activeCalls[uid];

    playSound('leave');
}

window.setVolume = (uid, val) => {
    const audio = document.getElementById(`audio-${uid}`);
    if (audio) audio.volume = val;
};

window.toggleUserMute = (uid) => {
    const audio = document.getElementById(`audio-${uid}`);
    const btn = document.getElementById(`mute-btn-${uid}`);
    if (audio) {
        audio.muted = !audio.muted;
        if (audio.muted) {
            btn.innerText = '🔇';
            btn.classList.add('is-muted');
        } else {
            btn.innerText = '🔊';
            btn.classList.remove('is-muted');
        }
    }
};

function toggleMyMute() {
    if (!myStream || isListener) return;

    // Audio track is always 0 in the pure audio stream, 
    // BUT in combined stream it might differ. 
    // Better look for 'audio' kind.
    const tracks = myStream.getAudioTracks();
    if (tracks.length > 0) {
        const enabled = !tracks[0].enabled;
        tracks.forEach(t => t.enabled = enabled);

        const btn = document.getElementById('my-mute-btn');
        if (enabled) {
            btn.innerText = t('ui.mute');
            btn.style.background = "linear-gradient(135deg, var(--accent-color), var(--accent-secondary))";
            btn.style.color = "#fff";
        } else {
            btn.innerText = t('ui.unmute');
            btn.style.background = "linear-gradient(135deg, var(--danger-color), #dc2626)";
            btn.style.color = "#fff";
        }
    }
}

async function renameSelf() {
    if (!socket) return;
    const nextName = await showAppPrompt(t('ui.renamePrompt'), myNickname);
    if (nextName === null) return;
    const trimmed = nextName.trim();
    if (!trimmed) return;
    socket.emit('rename-user', trimmed);
}

async function changeAvatar() {
    const result = await showAvatarPicker();
    if (!result) return;
    // Update all own avatars immediately
    updateAllMyAvatars();
    // Broadcast to other users
    if (socket) socket.emit('avatar-changed', { set: result.set, bg: result.bg });
}

function updateAllMyAvatars() {
    if (!myPeer) return;
    const uid = myPeer.id;
    const avatarEl = document.getElementById(`avatar-${uid}`);
    if (avatarEl) avatarEl.src = getAvatarUrl(myNickname, '64x64');
    updateParticipantsList();
}


// --- Screen Share Logic ---
async function toggleScreenShare() {
    const btn = document.getElementById('btn-share-screen-header');
    if (btn && btn.disabled) return;

    if (!localScreenStream) {
        // Request Permission from Server first
        socket.emit('request-share');
    } else {
        // STOP SHARING manually
        stopScreenShare();
    }
}

async function startScreenShareActual() {
    try {
        const btn = document.getElementById('btn-share-screen-header');
        // 1. Get Screen Stream (Request Audio!)
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true
        });

        // 2. Audio Mixing Logic (Web Audio API)
        const videoTracks = displayStream.getVideoTracks();
        let finalAudioTrack = null;

        // Check if user shared system audio
        const sysAudioTracks = displayStream.getAudioTracks();
        const micAudioTracks = myStream.getAudioTracks();

        if (sysAudioTracks.length > 0 && micAudioTracks.length > 0) {
            // MIXING REQUIRED
            try {
                audioMixerContext = new (window.AudioContext || window.webkitAudioContext)();
                const dest = audioMixerContext.createMediaStreamDestination();

                // Mic Source
                const micSource = audioMixerContext.createMediaStreamSource(myStream);
                micSource.connect(dest);

                // System Audio Source
                const sysSource = audioMixerContext.createMediaStreamSource(displayStream);
                sysSource.connect(dest);

                finalAudioTrack = dest.stream.getAudioTracks()[0];
                mixedAudioStream = dest.stream;

                // Important: If system audio track ends (unlikely alone), handle it? 
                // Actually main handling is on Video Track ending.

            } catch (err) {
                console.error("Audio Mixing Failed, falling back to mic:", err);
                finalAudioTrack = micAudioTracks[0];
            }
        } else if (micAudioTracks.length > 0) {
            // No System Audio, Just Mic
            finalAudioTrack = micAudioTracks[0];
        } else {
            await showAppAlert(t('ui.noAudioSource'));
            socket.emit('stop-share');
            return;
        }

        // 3. Create Final Stream
        localScreenStream = new MediaStream([videoTracks[0], finalAudioTrack]);

        // 4. Handle Local Stop
        videoTracks[0].onended = () => {
            stopScreenShare();
        };

        // 5. Update Self UI -> STAGE
        // Note: We intentionally mute the Stage Video (local preview) to avoid self-echo,
        // but we might want to hear system audio? 
        // Usually self-preview is muted. If user wants to hear system audio they hear it from source app.
        enableStage(localScreenStream, myNickname, myPeer.id);

        if (btn) {
            btn.innerText = t('ui.stopShare');
            btn.style.background = "linear-gradient(135deg, var(--danger-color), #dc2626)";
        }

        // 6. Re-Call everyone
        reCallAllPeers(localScreenStream);
        updateParticipantsList();

    } catch (err) {
        console.error("Screen share error:", err);
        socket.emit('stop-share'); // Release lock if user canceled
    }
}

function stopScreenShare() {
    if (!localScreenStream) return;

    // 1. Stop video tracks
    localScreenStream.getVideoTracks().forEach(t => t.stop());

    // Allow system audio track to stop too if it was raw, 
    // but if mixed, we close context below.
    localScreenStream.getAudioTracks().forEach(t => t.stop());

    localScreenStream = null;

    // 2. Clean up Mixer
    if (audioMixerContext) {
        audioMixerContext.close();
        audioMixerContext = null;
        mixedAudioStream = null;
    }

    // 3. Server Notify
    socket.emit('stop-share');

    // 4. Disable Stage
    disableStage();

    // 5. Reset Button
    const btn = document.getElementById('btn-share-screen-header');
    if (btn) {
        btn.innerText = t('ui.shareScreen');
        btn.style.background = "";
    }

    // 6. Re-Call everyone with Processed Audio Stream (myStream)
    reCallAllPeers(myStream);
    updateParticipantsList();
}

// --- Cinema Mode Helpers ---
let currentStageId = null;

function enableStage(stream, userName, uid) {
    const stage = document.getElementById('screen-stage');
    const video = document.getElementById('stage-video');
    const label = document.getElementById('screen-stage-label');
    const mainContent = document.getElementById('main-content');

    stage.style.display = 'flex';
    video.srcObject = new MediaStream(stream.getVideoTracks()); // Video Only for stage
    video.muted = true; // Audio is handled via separate audio element or user card
    label.innerText = t('ui.stageSharing', { name: userName });

    mainContent.classList.add('stage-active');
    currentStageId = uid;
}

function disableStage() {
    const stage = document.getElementById('screen-stage');
    const video = document.getElementById('stage-video');
    const mainContent = document.getElementById('main-content');

    stage.style.display = 'none';
    video.srcObject = null;
    mainContent.classList.remove('stage-active');
    currentStageId = null;
}

function isStageActive(uid) {
    return currentStageId === uid;
}

function closeStage() {
    disableStage();
}

// --- Fullscreen Logic ---
function toggleFullscreen() {
    const stage = document.getElementById('screen-stage');
    const btn = document.getElementById('fullscreen-btn');

    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        // Enter fullscreen
        if (stage.requestFullscreen) {
            stage.requestFullscreen();
        } else if (stage.webkitRequestFullscreen) {
            stage.webkitRequestFullscreen();
        }
        btn.innerText = t('ui.fullscreenExit');
    } else {
        // Exit fullscreen
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        }
        btn.innerText = t('ui.fullscreen');
    }
}

// Update button text when exiting fullscreen via ESC key
document.addEventListener('fullscreenchange', () => {
    const btn = document.getElementById('fullscreen-btn');
    if (btn) {
        btn.innerText = document.fullscreenElement ? t('ui.fullscreenExit') : t('ui.fullscreen');
    }
});

document.addEventListener('webkitfullscreenchange', () => {
    const btn = document.getElementById('fullscreen-btn');
    if (btn) {
        btn.innerText = document.webkitFullscreenElement ? t('ui.fullscreenExit') : t('ui.fullscreen');
    }
});

function lockShareButton(sharerId) {
    const btn = document.getElementById('btn-share-screen-header');
    if (!btn) return;

    if (myPeer && myPeer.id === sharerId) return; // Don't lock for self (handled by state)

    btn.disabled = true;
    btn.title = t('ui.shareLockedTitle');
    btn.style.opacity = '0.5';
    btn.style.cursor = 'not-allowed';
}

function unlockShareButton() {
    const btn = document.getElementById('btn-share-screen-header');
    if (!btn) return;

    btn.disabled = false;
    btn.title = t('ui.shareScreen');
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
}

function reCallAllPeers(newStream) {
    // Close existing calls (MediaConnections)
    Object.values(activeCalls).forEach(call => {
        call.close();
    });
    // Clear activeCalls list (will fill up again)
    // Note: We do NOT remove the User Cards.

    // Re-Call all users in 'nicknames' list except self
    Object.keys(nicknames).forEach(peerId => {
        if (peerId === myPeer.id) return;

        const call = myPeer.call(peerId, newStream);
        activeCalls[peerId] = call;

        const name = nicknames[peerId];

        call.on('stream', stream => {
            addUser(stream, peerId, name);
        });

        call.on('close', () => {
            const videoEl = document.getElementById(`video-${peerId}`);
            if (videoEl) videoEl.style.display = 'none';
            const avatarEl = document.getElementById(`avatar-${peerId}`);
            if (avatarEl) avatarEl.style.display = 'block';
        });
    });
}
