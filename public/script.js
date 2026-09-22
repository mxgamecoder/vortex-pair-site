/* =============================================================
 * Vortex Pair Site — Frontend Logic
 * -------------------------------------------------------------
 * Flow:
 *   1. User enters phone number → generatePair()
 *   2. POST /api/pair/request  → server starts Baileys socket
 *   3. Poll  /api/pair/status  → receive pair code, then session string
 *   4. User receives the session via WhatsApp
 * ============================================================= */

// --- DOM refs ---------------------------------------------------------------
const el = {
  step1:        document.getElementById('step1'),
  step2:        document.getElementById('step2'),
  step3:        document.getElementById('step3'),
  phaseInput:   document.getElementById('phase-input'),
  phasePairing: document.getElementById('phase-pairing'),
  phaseSession: document.getElementById('phase-session'),
  phone:        document.getElementById('phone'),
  btnGenerate:  document.getElementById('btnGenerate'),
  pairCode:     document.getElementById('pairCode'),
  pairingStatus:document.getElementById('pairingStatus'),
  sessionStatus:document.getElementById('sessionStatus'),
  errorBox:     document.getElementById('errorBox'),
  errorText:    document.getElementById('errorText'),
  toast:        document.getElementById('toast'),
};

// --- State ------------------------------------------------------------------
let currentSessionId = null;
let currentPhone = null;
let pollTimer = null;
let pollStart = 0;
const POLL_TIMEOUT = 5 * 60 * 1000;   // stop polling after 5 min
const POLL_INTERVAL = 2500;           // poll every 2.5s

// --- UI helpers -------------------------------------------------------------
function showPhase(phase) {
  el.phaseInput.classList.toggle('hidden',   phase !== 'input');
  el.phasePairing.classList.toggle('hidden', phase !== 'pairing');
  el.phaseSession.classList.toggle('hidden', phase !== 'session');
}

function setStep(n) {
  [el.step1, el.step2, el.step3].forEach((s, i) => {
    s.classList.toggle('active', i < n);
    s.classList.toggle('done',   i < n - 1);
  });
}

function showError(msg) {
  el.errorText.textContent = msg;
  el.errorBox.classList.remove('hidden');
  showPhase('input');
  setStep(1);
}

function hideError() {
  el.errorBox.classList.add('hidden');
  el.errorText.textContent = '';
}

function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  setTimeout(() => el.toast.classList.remove('show'), 2200);
}

// --- Sanitize phone input ---------------------------------------------------
function cleanPhone(raw) {
  // strip everything except digits
  return String(raw || '').replace(/[^0-9]/g, '');
}

// --- generatePair() — kick off pairing -------------------------------------
async function generatePair() {
  hideError();
  const rawPhone = el.phone.value.trim();
  const phone = cleanPhone(rawPhone);

  if (!phone) {
    showError('Please enter your WhatsApp phone number with country code.');
    return;
  }
  if (phone.length < 8 || phone.length > 15) {
    showError('Phone number must be 8–15 digits, country code first (e.g. 27123456789).');
    return;
  }

  el.btnGenerate.disabled = true;
  el.btnGenerate.textContent = 'Starting…';
  el.pairingStatus.textContent = 'Connecting to WhatsApp servers…';
  el.pairCode.textContent = '······';
  showPhase('pairing');
  setStep(2);

  try {
    const resp = await fetch('/api/pair/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const data = await resp.json();

    if (!resp.ok || !data.sessionId) {
      throw new Error(data.error || 'Failed to start pairing session.');
    }

    currentSessionId = data.sessionId;
    currentPhone = phone;
    pollStart = Date.now();
    startPolling();
  } catch (err) {
    showError(err.message || 'Network error. Please try again.');
  } finally {
    el.btnGenerate.disabled = false;
    el.btnGenerate.textContent = 'Generate Pair Code';
  }
}

// --- Polling ----------------------------------------------------------------
function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollStatus, POLL_INTERVAL);
  pollStatus(); // immediate first poll
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollStatus() {
  if (!currentSessionId) { stopPolling(); return; }
  if (Date.now() - pollStart > POLL_TIMEOUT) {
    stopPolling();
    showError('Pairing timed out. Please try again.');
    return;
  }

  try {
    const resp = await fetch(`/api/pair/status?sessionId=${encodeURIComponent(currentSessionId)}`);
    const data = await resp.json();

    if (!resp.ok) {
      stopPolling();
      showError(data.error || 'Session expired or not found.');
      return;
    }

    // Update pair code display
    if (data.pairCode) {
      el.pairCode.textContent = data.pairCode;
    }

    // Status messages
    switch (data.status) {
      case 'pending':
        el.pairingStatus.textContent = 'Connecting to WhatsApp servers…';
        break;
      case 'pairing':
        el.pairingStatus.textContent = 'Enter the code in WhatsApp → Linked Devices → Link a Device';
        break;
      case 'connected':
        stopPolling();
        if (data.sessionString) {
          showSession(data.sessionString);
        } else {
          el.pairingStatus.textContent = 'Connected! Building session ID…';
          // keep polling briefly for the string
          setTimeout(() => {
            if (currentSessionId) {
              pollTimer = setInterval(pollStatus, 1500);
              setTimeout(stopPolling, 8000);
            }
          }, 500);
        }
        return;
      case 'logged_out':
        stopPolling();
        showError('Link was rejected or cancelled. Please generate a new code.');
        return;
      case 'error':
        stopPolling();
        showError('Something went wrong on the server. Please try again.');
        return;
      case 'timeout':
        stopPolling();
        showError('Pairing session expired. Please try again.');
        return;
    }
  } catch (err) {
    // transient network blip — keep polling, don't hard-fail
    el.pairingStatus.textContent = 'Checking connection…';
  }
}

// --- Show session ID --------------------------------------------------------
function showSession(_sessionString) {
  stopPolling();
  setStep(3);
  el.sessionStatus.textContent = 'The session has been sent to your paired WhatsApp number.';
  el.pairingStatus.textContent = '';
  showPhase('session');
  showToast('✅ Session delivered!');
}

// --- cancelPairing() --------------------------------------------------------
function cancelPairing() {
  stopPolling();
  if (currentSessionId) {
    fetch(`/api/pair/cancel?sessionId=${encodeURIComponent(currentSessionId)}`, { method: 'POST' })
      .catch(() => {});
  }
  currentSessionId = null;
  resetAll();
}

// --- resetAll() -------------------------------------------------------------
function resetAll() {
  stopPolling();
  currentSessionId = null;
  currentPhone = null;
  el.phone.value = '';
  el.pairCode.textContent = '······';
  el.pairingStatus.textContent = 'Waiting for you to link…';
  el.sessionStatus.textContent = 'The session will be sent to your paired WhatsApp number.';
  hideError();
  showPhase('input');
  setStep(1);
}

// --- Enter-key shortcut on phone input -------------------------------------
el.phone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    generatePair();
  }
});

// --- Boot -------------------------------------------------------------------
showPhase('input');
setStep(1);
