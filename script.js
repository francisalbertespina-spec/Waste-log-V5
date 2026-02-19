// ═══════════════════════════════════════════════════════════════════════════
// HDJV WMS — script.js
// ═══════════════════════════════════════════════════════════════════════════

let selectedPackage       = "";
let compressedImageBase64 = "";
let toastQueue            = [];
let activeToast           = null;
let toastTimer            = null;
let selectedWasteType     = "";
window.isUploading        = false;

let activeSubmissions      = new Set();
let submissionFingerprints = new Map();
const FINGERPRINT_LOCK_DURATION = 120000;

// ═══════════════════════════════════════════════════════════════════════════
// 1. PUSH NOTIFICATION ENGINE  (admin-only)
// ═══════════════════════════════════════════════════════════════════════════

let swRegistration        = null;
let notifPollingTimer     = null;
let lastKnownPendingCount = 0;
let notifPermission       = 'default';

async function initNotifications() {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
  notifPermission = Notification.permission;
  try {
    swRegistration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    navigator.serviceWorker.addEventListener('message', handleSwMessage);
  } catch (err) { console.warn('[NOTIF] SW reg failed:', err); }
  updateNotifUI();
  if (notifPermission === 'granted') startNotifPolling();
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) { showToast('Notifications not supported','error'); return false; }
  const result = await Notification.requestPermission();
  notifPermission = result;
  updateNotifUI();
  if (result === 'granted') {
    showToast('🔔 Notifications enabled!','success');
    startNotifPolling();
    await checkPendingUsers(true);
    return true;
  }
  showToast('Notifications blocked — enable in browser settings','info');
  return false;
}

function startNotifPolling() {
  if (notifPollingTimer) return;
  const role = localStorage.getItem('userRole');
  if (role !== 'admin' && role !== 'super_admin') return;
  checkPendingUsers(false);
  notifPollingTimer = setInterval(() => checkPendingUsers(false), 2 * 60 * 1000);
}

function stopNotifPolling() {
  if (notifPollingTimer) { clearInterval(notifPollingTimer); notifPollingTimer = null; }
}

async function checkPendingUsers(forceNotify = false) {
  const role = localStorage.getItem('userRole');
  if (role !== 'admin' && role !== 'super_admin') return;
  if (notifPermission !== 'granted') return;
  try {
    const res   = await authenticatedFetch(`${scriptURL}?action=getUsers`);
    const users = await res.json();
    if (!Array.isArray(users)) return;
    const pending = users.filter(u => u.status === 'Pending');
    const count   = pending.length;
    updatePendingBadge(count);
    if (count > 0 && (forceNotify || count > lastKnownPendingCount)) {
      const diff = count - lastKnownPendingCount;
      fireAdminNotification(count, diff > 0 ? diff : count, pending);
    }
    lastKnownPendingCount = count;
  } catch (err) { console.error('[NOTIF] poll error:', err); }
}

function fireAdminNotification(total, newCount, pendingUsers) {
  if (notifPermission !== 'granted') return;
  const title = '⏳ WMS — Pending Approvals';
  const body  = newCount === 1
    ? `${pendingUsers[0]?.email || 'A user'} is waiting for approval`
    : `${total} user${total > 1 ? 's' : ''} waiting for approval`;

  if (swRegistration) {
    navigator.serviceWorker.ready.then(reg => {
      reg.showNotification(title, {
        body, icon: './logo.png', badge: './logo.png',
        tag: 'wms-pending', renotify: true, requireInteraction: true,
        data: { type: 'approval_request' },
        actions: [
          { action: 'open_admin', title: '👥 Review Now' },
          { action: 'dismiss',    title: 'Later' }
        ]
      });
    });
  } else {
    const n = new Notification(title, { body, icon:'./logo.png', tag:'wms-pending', requireInteraction:true });
    n.onclick = () => { window.focus(); showSection('user-management-section'); loadUsers(); n.close(); };
  }
}

function handleSwMessage(event) {
  if (event.data?.type === 'NAVIGATE_TO_ADMIN') {
    showSection('user-management-section');
    loadUsers();
  }
}

function updatePendingBadge(count) {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  badge.textContent   = count > 99 ? '99+' : count;
  badge.style.display = count > 0 ? 'flex' : 'none';
}

function updateNotifUI() {
  // Header bell
  const bell = document.getElementById('notif-bell');
  if (bell) {
    bell.classList.toggle('notif-on',  notifPermission === 'granted');
    bell.classList.toggle('notif-off', notifPermission !== 'granted');
    bell.title = notifPermission === 'granted' ? 'Notifications enabled — click to check now'
               : notifPermission === 'denied'  ? 'Notifications blocked in browser settings'
               : 'Click to enable notifications';
  }
  // Settings page status (rendered on demand)
  renderNotifSettingsRow();
}

function renderNotifSettingsRow() {
  const status = document.getElementById('settings-notif-status');
  const btn    = document.getElementById('settings-notif-btn');
  if (!status) return;
  if (notifPermission === 'granted') {
    status.textContent = '🟢 Enabled'; status.style.color = '#4caf50';
    if (btn) { btn.textContent = '🔕 How to disable'; btn.disabled = false; btn.onclick = showDisableGuide; }
  } else if (notifPermission === 'denied') {
    status.textContent = '🔴 Blocked'; status.style.color = '#f44336';
    if (btn) { btn.textContent = 'Blocked in browser'; btn.disabled = true; }
  } else {
    status.textContent = '⚪ Not enabled'; status.style.color = '#999';
    if (btn) { btn.textContent = '🔔 Enable Notifications'; btn.disabled = false; btn.onclick = requestNotificationPermission; }
  }
}

function onBellClick() {
  if (notifPermission === 'default') { requestNotificationPermission(); }
  else if (notifPermission === 'granted') { checkPendingUsers(true); showToast('Checking pending approvals…','info',{duration:1800}); }
  else { showToast('Notifications blocked — allow in browser site settings','info'); }
}

function showDisableGuide() {
  showToast('In browser: Site settings → Notifications → Block this site','info');
}

async function sendTestNotification() {
  if (notifPermission !== 'granted') {
    const ok = await requestNotificationPermission();
    if (!ok) return;
  }
  const show = () => {
    if (swRegistration) {
      navigator.serviceWorker.ready.then(r => r.showNotification('✅ WMS Test', { body:'Notifications are working!', icon:'./logo.png', tag:'wms-test' }));
    } else {
      new Notification('✅ WMS Test', { body:'Notifications are working!', icon:'./logo.png' });
    }
  };
  show();
  showToast('Test notification sent!','success');
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTHENTICATED FETCH
// ═══════════════════════════════════════════════════════════════════════════

async function authenticatedFetch(url, options = {}) {
  const token = localStorage.getItem('userToken');
  if (!token && !url.includes('email=')) { handleSessionExpired(); throw new Error('No authentication token'); }
  if (token && !url.includes('token=')) { url += (url.includes('?') ? '&' : '?') + 'token=' + token; }
  if (options.method === 'POST' && options.body) {
    try { const b = JSON.parse(options.body); if (!b.token && token) { b.token = token; options.body = JSON.stringify(b); } } catch {}
  }
  try {
    const r = await fetch(url, options);
    if (r.status === 401) { try { const d = await r.json(); if (d.message && d.message !== 'Unauthorized') showToast(d.message,'error'); } catch {} handleSessionExpired(); throw new Error('Unauthorized'); }
    if (r.status === 403) { showToast('Permission denied','error'); throw new Error('Forbidden'); }
    if (r.status === 429) { showToast('Too many requests — wait a moment','error'); throw new Error('Rate limit'); }
    if (r.status === 500) { showToast('Server error — try again','error'); throw new Error('Server error'); }
    return r;
  } catch (e) {
    if (['Unauthorized','Forbidden','Rate limit','Server error'].includes(e.message)) throw e;
    if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) { showToast('Network error — check connection','error'); throw new Error('Network error'); }
    throw e;
  }
}

const DEV_MODE  = false;
const scriptURL = "https://script.google.com/macros/s/AKfycbyMHs_Dtm0qejMBMkt0w6DFIYSGq-S07RMrVK4roCQ-V84W25V_cw5dgGd_pfGnm2Ay/exec";

// ═══════════════════════════════════════════════════════════════════════════
// SESSION
// ═══════════════════════════════════════════════════════════════════════════

const SESSION_CHECK_INTERVAL = 5 * 60 * 1000;
let sessionCheckTimer = null;

function isTokenExpired() { const e = localStorage.getItem('tokenExpiry'); return !e || Date.now() >= parseInt(e); }
function getTimeUntilExpiry() { const e = localStorage.getItem('tokenExpiry'); return !e ? 0 : Math.floor((parseInt(e)-Date.now())/60000); }

async function validateSession() {
  if (!localStorage.getItem('userToken') || isTokenExpired()) { handleSessionExpired(); return false; }
  try { const r = await authenticatedFetch(`${scriptURL}?action=validateToken`); const d = await r.json(); if (d.valid) { if (d.tokenExpiry) localStorage.setItem('tokenExpiry',d.tokenExpiry); return true; } handleSessionExpired(); return false; }
  catch { return false; }
}

function handleSessionExpired() {
  ['userToken','tokenExpiry','userRole','userEmail'].forEach(k => localStorage.removeItem(k));
  document.body.classList.remove('is-admin');
  const ui = document.getElementById('user-info'); if (ui) ui.style.display = 'none';
  showSection('login-section');
  showToast('Session expired — please sign in again','info');
  if (sessionCheckTimer) { clearInterval(sessionCheckTimer); sessionCheckTimer = null; }
  stopTokenRefreshTimer(); stopNotifPolling();
}

function startSessionMonitoring() {
  if (sessionCheckTimer) clearInterval(sessionCheckTimer);
  sessionCheckTimer = setInterval(validateSession, SESSION_CHECK_INTERVAL);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) validateSession(); });
  startTokenRefreshTimer();
}

let tokenRefreshTimer = null;
function startTokenRefreshTimer() {
  if (tokenRefreshTimer) { clearInterval(tokenRefreshTimer); tokenRefreshTimer = null; }
  checkAndRefreshToken();
  tokenRefreshTimer = setInterval(checkAndRefreshToken, 30 * 60 * 1000);
}
function stopTokenRefreshTimer() { if (tokenRefreshTimer) { clearInterval(tokenRefreshTimer); tokenRefreshTimer = null; } }

async function refreshUserToken() {
  try { const r = await authenticatedFetch(`${scriptURL}?action=refreshToken`); const d = await r.json(); if (d.success && d.tokenExpiry) { localStorage.setItem('tokenExpiry',d.tokenExpiry); return true; } return false; } catch { return false; }
}
async function checkAndRefreshToken() {
  const m = getTimeUntilExpiry();
  if (m <= 0) return;
  if (m < 1440) { const ok = await refreshUserToken(); if (ok) showToast(`Session extended ${Math.floor(getTimeUntilExpiry()/60/24)}d`,'success',{duration:2000}); else if (m < 60) showToast('Session expiring soon','error'); }
}

// ═══════════════════════════════════════════════════════════════════════════
// DUPLICATE PREVENTION
// ═══════════════════════════════════════════════════════════════════════════

function markSubmissionAsCompleted(fp) {
  const o = JSON.parse(localStorage.getItem('completedSubmissions')||'{}');
  o[fp] = Date.now();
  const cut = Date.now()-86400000; for (const k in o) if (o[k]<cut) delete o[k];
  localStorage.setItem('completedSubmissions', JSON.stringify(o));
}
function isSubmissionCompleted(fp) {
  const o = JSON.parse(localStorage.getItem('completedSubmissions')||'{}');
  return o[fp] ? { completed:true, hoursSince: Math.floor((Date.now()-o[fp])/3600000) } : { completed:false };
}
function generateRequestId(fp) { return `${fp}-${new Date().toISOString().split('T')[0]}`.replace(/[^a-zA-Z0-9-]/g,'_'); }

// ═══════════════════════════════════════════════════════════════════════════
// WATERMARK
// ═══════════════════════════════════════════════════════════════════════════

async function stampImageWithWatermark(file, email, pkg) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { alert("GPS not supported"); return reject("No GPS"); }
    navigator.geolocation.getCurrentPosition(pos => {
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      const img = new Image(), reader = new FileReader();
      reader.onload = () => {
        img.onload = () => {
          const c = document.createElement("canvas"), x = c.getContext("2d");
          c.width = img.width; c.height = img.height; x.drawImage(img,0,0);
          const now = new Date(), p = n => String(n).padStart(2,"0");
          const ts = `${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
          const lines = [`HDJV ENVI UNIT`,ts,`Lat:${lat.toFixed(4)} Lng:${lng.toFixed(4)}`,`User:${email}`,`Pkg:${pkg}`];
          const bfs=Math.max(40,Math.floor(c.width/28)),blh=bfs*1.5,bp=bfs;
          const calcH=lines.length*blh+bp*2, maxH=c.height*0.20, s=calcH>maxH?maxH/calcH:1;
          const fh=calcH>maxH?maxH:calcH, fs=bfs*s, lh=blh*s, pd=bp*s;
          x.fillStyle="rgba(0,0,0,0.75)"; x.fillRect(0,c.height-fh,c.width,fh);
          x.fillStyle="white"; x.font=`bold ${fs}px Arial`; x.textBaseline="top";
          lines.forEach((l,i)=>x.fillText(l,pd,c.height-fh+pd+i*lh));
          resolve(c.toDataURL("image/jpeg",0.85));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    }, err => { alert("GPS required."); reject(err); }, {enableHighAccuracy:true,timeout:10000});
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════════════════

function showToast(msg, type="info", opts={}) {
  const { persistent=false, spinner=false, duration=3000 } = opts;
  toastQueue.push({msg,type,persistent,spinner,duration});
  processToastQueue();
}
function processToastQueue() {
  if (activeToast || !toastQueue.length) return;
  const {msg,type,persistent,spinner,duration} = toastQueue.shift();
  const t = document.createElement("div"); t.className=`toast ${type}`;
  const ic = document.createElement("div"); ic.className="toast-icon";
  if (spinner) { const s=document.createElement("div"); s.className="toast-spinner"; ic.appendChild(s); }
  else ic.textContent = {success:"✅",error:"❌",info:"ℹ️"}[type]||"ℹ️";
  t.appendChild(ic);
  const m = document.createElement("div"); m.className="toast-message"; m.textContent=msg;
  t.appendChild(m); document.body.appendChild(t); activeToast=t;
  if (!persistent) toastTimer = setTimeout(()=>dismissToast(t), type==="error"?8000:duration||3000);
}
function dismissToast(t) {
  if (!t) return; clearTimeout(toastTimer); toastTimer=null;
  t.classList.add("hide");
  setTimeout(()=>{ t.remove(); activeToast=null; processToastQueue(); },300);
}
function setLoginLoading(on) {
  const b=document.getElementById("buttonDiv"), l=document.getElementById("loginLoadingUI");
  if (!b||!l) return;
  b.style.display=on?"none":"flex"; l.style.display=on?"flex":"none";
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTIONS
// ═══════════════════════════════════════════════════════════════════════════

function showSection(id) {
  const adminOnly = ['admin-dashboard','user-management-section','request-logs-section','analytics-section'];
  const protected_ = ['package-section','waste-type-section','hazardous-menu-section','hazardous-form-section',
    'hazardous-history-section','solid-menu-section','solid-form-section','solid-history-section',
    'user-settings-section',...adminOnly];
  if (protected_.includes(id)) {
    if (!localStorage.getItem('userToken') || isTokenExpired()) { handleSessionExpired(); return; }
    if (adminOnly.includes(id)) {
      const r = localStorage.getItem('userRole');
      if (r !== 'admin' && r !== 'super_admin') { showToast('Admin access required','error'); showSection('package-section'); return; }
    }
  }
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  updateToggleState(id); updateBreadcrumbs();
}

function updateBreadcrumbs() {
  if (!selectedPackage) return;
  const lbl = `Package ${selectedPackage.replace('P','')}`;
  ['current-package','waste-type-package','hazardous-menu-package','hazardous-form-package',
   'hazardous-history-package','solid-menu-package','solid-form-package','solid-history-package']
  .forEach(id=>{ const el=document.getElementById(id); if(el) el.textContent=lbl; });
}

function selectPackage(pkg, el) { document.querySelectorAll('.package-card').forEach(c=>c.classList.remove('selected')); el.classList.add('selected'); selectedPackage=pkg; }
function confirmPackage() { if (!selectedPackage){showToast("Select a package first","error");return;} updateBreadcrumbs(); showSection("waste-type-section"); }
function backToPackage() { selectedPackage=""; document.querySelectorAll('.package-card').forEach(c=>c.classList.remove('selected')); showSection("package-section"); }
function showLogForm(t) { showSection(`${t}-form-section`); document.getElementById(`${t}-date`).valueAsDate=new Date(); }
function showHistoryView(t) { const today=new Date(), week=new Date(today-7*86400000); showSection(`${t}-history-section`); document.getElementById(`${t}-toDate`).valueAsDate=today; document.getElementById(`${t}-fromDate`).valueAsDate=week; }
function selectWasteType(t) { selectedWasteType=t; showSection(`${t}-menu-section`); }
function backToWasteType()     { showSection('waste-type-section'); }
function backToHazardousMenu() { showSection('hazardous-menu-section'); }
function backToSolidMenu()     { showSection('solid-menu-section'); }

// ═══════════════════════════════════════════════════════════════════════════
// 2. USER SETTINGS
// ═══════════════════════════════════════════════════════════════════════════

function showUserSettings() { showSection('user-settings-section'); renderUserSettings(); }

function renderUserSettings() {
  const email  = localStorage.getItem('userEmail') || '—';
  const role   = localStorage.getItem('userRole')  || 'user';
  const expiry = localStorage.getItem('tokenExpiry');
  const prefs  = JSON.parse(localStorage.getItem('userPrefs')||'{}');

  document.getElementById('settings-email').textContent = email;
  document.getElementById('settings-role').textContent  = role==='super_admin'?'Super Admin':role.charAt(0).toUpperCase()+role.slice(1);
  if (expiry) {
    const d = new Date(parseInt(expiry)), days = Math.max(0,Math.floor((parseInt(expiry)-Date.now())/86400000));
    document.getElementById('settings-session').textContent = `${d.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})} (${days}d)`;
  }
  const done = JSON.parse(localStorage.getItem('completedSubmissions')||'{}');
  document.getElementById('settings-submissions').textContent = Object.keys(done).length;

  const dp = document.getElementById('pref-default-package'); if (dp) dp.value = prefs.defaultPackage||'';
  const th = document.getElementById('pref-theme');           if (th) th.value = prefs.theme||'default';
  applyTheme(prefs.theme||'default');
  notifPermission = Notification.permission;
  renderNotifSettingsRow();
}

function saveUserSettings() {
  const prefs = {
    defaultPackage: document.getElementById('pref-default-package')?.value||'',
    theme: document.getElementById('pref-theme')?.value||'default'
  };
  localStorage.setItem('userPrefs', JSON.stringify(prefs));
  applyTheme(prefs.theme);
  showToast('Settings saved!','success');
}

function applyTheme(t) {
  document.body.classList.remove('theme-dark','theme-compact');
  if (t==='dark')    document.body.classList.add('theme-dark');
  if (t==='compact') document.body.classList.add('theme-compact');
}

function clearSessionHistory() {
  if (!confirm('Clear local submission history?\nServer data is not affected.')) return;
  localStorage.removeItem('completedSubmissions');
  showToast('Local history cleared','success');
  renderUserSettings();
}

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════════════════════

function showUserManagement() { showSection("user-management-section"); loadUsers(); }
function showRequestLogs()    { showSection("request-logs-section");    loadRequests(); }
function backToAdminDashboard() { showSection("admin-dashboard"); }
function showAnalytics()       { showSection("analytics-section"); loadAnalytics(); }

async function loadUsers() {
  try {
    const res   = await authenticatedFetch(`${scriptURL}?action=getUsers`);
    const users = await res.json();
    renderUsers(users);
    if (Array.isArray(users)) { const p=users.filter(u=>u.status==='Pending').length; updatePendingBadge(p); lastKnownPendingCount=p; }
  } catch { showToast("Failed to load users","error"); }
}

function renderUsers(users) {
  const tbody = document.getElementById("usersTableBody");
  tbody.innerHTML = "";
  if (!users || !users.length) { tbody.innerHTML=`<tr><td colspan="4" style="text-align:center;padding:20px;color:#999;">No users found</td></tr>`; return; }
  const me=localStorage.getItem("userEmail"), myRole=localStorage.getItem("userRole");
  const isSA=myRole==="super_admin", isA=myRole==="admin";
  const list = isSA ? users : users.filter(u=>u.status==='Pending'||['admin','super_admin'].includes(u.role));

  list.forEach(u => {
    const tr=document.createElement("tr"), isMe=u.email.toLowerCase()===me?.toLowerCase();
    const canS=isSA||(isA&&u.status==='Pending'), canR=isSA&&!isMe;
    const statSel=`<select class="admin-select status-select" value="${u.status}" ${canS?'':'disabled'} onchange="updateUserStatus('${u.email}',this.value)">${['Pending','Approved','Rejected'].map(o=>`<option value="${o}" ${u.status===o?'selected':''}>${o}</option>`).join('')}</select>`;
    const rOpts=isSA?['user','admin','super_admin']:['user','admin'];
    const roleSel=`<select class="admin-select role-select" value="${u.role||'user'}" ${canR?'':'disabled'} onchange="updateUserRole('${u.email}',this.value)">${rOpts.map(o=>`<option value="${o}" ${(u.role||'user')===o?'selected':''}>${o==='super_admin'?'Super Admin':o[0].toUpperCase()+o.slice(1)}</option>`).join('')}</select>`;
    let actions = canS && u.status==='Pending'
      ? `<button class="btn-action btn-approve" onclick="quickApprove('${u.email}')">✓</button><button class="btn-action btn-reject" onclick="quickReject('${u.email}')">✗</button>`
      : isSA&&!isMe ? `<button class="btn-action btn-delete" onclick="deleteUser('${u.email}')">🗑️</button>`
      : `<span style="color:#999;font-size:0.85rem;">—</span>`;
    tr.innerHTML=`<td style="text-align:left;">${u.email}${isMe?' <span style="color:#999;font-size:0.72rem;">(You)</span>':''}</td><td>${statSel}</td><td>${roleSel}</td><td class="action-cell">${actions}</td>`;
    tbody.appendChild(tr);
  });
  applyDropdownStyling();
}

function applyDropdownStyling() {
  document.querySelectorAll('.status-select,.role-select').forEach(s=>s.setAttribute('value',s.value));
}

async function quickApprove(email) {
  try { const r=await authenticatedFetch(`${scriptURL}?action=approveUser&email=${encodeURIComponent(email)}`); const d=await r.json(); if(d.success||d.status==='success'){showToast('User approved','success');await loadUsers();}else showToast(d.message||'Failed','error'); } catch(e){showToast(e.message,'error');}
}
async function quickReject(email) {
  try { const r=await authenticatedFetch(`${scriptURL}?action=rejectUser&email=${encodeURIComponent(email)}`); const d=await r.json(); if(d.success||d.status==='success'){showToast('User rejected','success');await loadUsers();}else showToast(d.message||'Failed','error'); } catch(e){showToast(e.message,'error');}
}
async function updateUserStatus(email,status) {
  try { const action=status==='Approved'?'approveUser':status==='Rejected'?'rejectUser':'updateUserStatus'; const sel=event?.target; if(sel){sel.classList.add('loading');sel.disabled=true;} const r=await authenticatedFetch(`${scriptURL}?action=${action}&email=${encodeURIComponent(email)}&status=${status}`); const d=await r.json(); if(sel){sel.classList.remove('loading');sel.disabled=false;} if(d.success||d.status==='success'){showToast(`Status → ${status}`,'success');await loadUsers();}else{showToast(d.message||'Failed','error');await loadUsers();} } catch(e){showToast(e.message,'error');await loadUsers();}
}
async function updateUserRole(email,role) {
  try { const sel=event?.target; if(sel){sel.classList.add('loading');sel.disabled=true;} const r=await authenticatedFetch(`${scriptURL}?action=updateUserRole&email=${encodeURIComponent(email)}&role=${role}`); const d=await r.json(); if(sel){sel.classList.remove('loading');sel.disabled=false;} if(d.success||d.status==='success'){showToast(`Role → ${role}`,'success');await loadUsers();}else{showToast(d.message||'Failed','error');await loadUsers();} } catch(e){showToast(e.message,'error');await loadUsers();}
}
async function deleteUser(email) {
  if(!confirm(`Delete ${email}?\nCannot be undone.`))return;
  try { const r=await authenticatedFetch(`${scriptURL}?action=deleteUser&email=${encodeURIComponent(email)}`); const d=await r.json(); if(d.success||d.status==='success'){showToast('Deleted','success');loadUsers();}else showToast(d.message||'Failed','error'); } catch{showToast('Error deleting','error');}
}
async function loadRequests() {
  try { const r=await authenticatedFetch(`${scriptURL}?action=getRequests`); const list=await r.json(); const tb=document.getElementById("requestsTableBody"); tb.innerHTML=""; list.forEach(req=>{const tr=document.createElement("tr"); tr.innerHTML=`<td style="text-align:left;">${req.id}</td><td>${new Date(req.time).toLocaleString()}</td>`; tb.appendChild(tr);}); } catch{showToast("Failed to load logs","error");}
}

// ═══════════════════════════════════════════════════════════════════════════
// 4+5. ANALYTICS (admin-only) + CHARTS
// ═══════════════════════════════════════════════════════════════════════════

let chartInstances = {};
function destroyChart(k) { if(chartInstances[k]){chartInstances[k].destroy();delete chartInstances[k];} }

// Track last loaded analytics data for PDF export
window.lastAnalyticsData = null;

function toggleAnalyticsFilterMode() {
  const mode = document.getElementById('analytics-filter-mode')?.value;
  const isPeriod = mode === 'period';
  document.getElementById('analytics-period-col').style.display   = isPeriod ? '' : 'none';
  document.getElementById('analytics-range-col').style.display    = isPeriod ? 'none' : '';
  document.getElementById('analytics-range-col-to').style.display = isPeriod ? 'none' : '';
}

async function loadAnalytics() {
  const pkg    = document.getElementById('analytics-package')?.value || 'P4';
  const wtype  = document.getElementById('analytics-waste-type')?.value || 'hazardous';
  const mode   = document.getElementById('analytics-filter-mode')?.value || 'period';
  const today  = new Date();

  let from, to, periodLabel;
  if (mode === 'range') {
    from = document.getElementById('analytics-from')?.value;
    to   = document.getElementById('analytics-to')?.value;
    if (!from || !to) { showToast('Please select both From and To dates', 'error'); return; }
    if (from > to)    { showToast('From date must be before To date', 'error'); return; }
    const ms = new Date(to) - new Date(from);
    const days = Math.round(ms / 86400000) + 1;
    periodLabel = from + ' to ' + to;
    window._analyticsDays = days;
  } else {
    const period = parseInt(document.getElementById('analytics-period')?.value || '30');
    from = new Date(today - period * 86400000).toISOString().split('T')[0];
    to   = today.toISOString().split('T')[0];
    periodLabel = 'Past ' + period + ' days';
    window._analyticsDays = period;
  }

  const pdfBtn = document.getElementById('analytics-pdf-btn');
  if (pdfBtn) pdfBtn.disabled = true;

  document.getElementById('analytics-loading').style.display = 'flex';
  document.getElementById('analytics-content').style.display = 'none';

  try {
    const res  = await authenticatedFetch(scriptURL + '?package=' + pkg + '&wasteType=' + wtype + '&from=' + from + '&to=' + to);
    const rows = await res.json();
    document.getElementById('analytics-loading').style.display = 'none';
    document.getElementById('analytics-content').style.display = 'block';

    if (!rows || rows.error || rows.length <= 1) {
      document.getElementById('analytics-no-data').style.display = 'block';
      document.getElementById('analytics-charts').style.display  = 'none';
      window.lastAnalyticsData = null;
      return;
    }
    document.getElementById('analytics-no-data').style.display = 'none';
    document.getElementById('analytics-charts').style.display  = 'block';

    const dr = rows.slice(1);
    let tv = 0; const wc = {}, uc = {}, daily = {};
    dr.forEach(r => {
      const v = wtype === 'hazardous' ? parseFloat(r[1]) || 0 : 1; tv += v;
      wc[r[2] || 'Unknown'] = (wc[r[2] || 'Unknown'] || 0) + 1;
      uc[r[4] || 'Unknown'] = (uc[r[4] || 'Unknown'] || 0) + 1;
      const ds = new Date(r[0]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      daily[ds] = (daily[ds] || 0) + v;
    });
    const tw = Object.entries(wc).sort((a, b) => b[1] - a[1])[0];

    document.getElementById('kpi-entries').textContent   = dr.length;
    document.getElementById('kpi-volume').textContent    = wtype === 'hazardous' ? tv.toFixed(2) + ' kg' : dr.length;
    document.getElementById('kpi-top-waste').textContent = tw ? tw[0].split(' ').slice(0, 3).join(' ') : '—';
    document.getElementById('kpi-avg-day').textContent   = (dr.length / window._analyticsDays).toFixed(1);

    renderTrendChart(daily, wtype);
    renderBreakdownChart(wc);
    renderContributors(uc);

    window.lastAnalyticsData = { dr, wc, uc, daily, tv, tw, wtype, pkg, periodLabel, from, to };
    if (pdfBtn) pdfBtn.disabled = false;

  } catch (err) {
    document.getElementById('analytics-loading').style.display = 'none';
    showToast('Error loading analytics', 'error');
    console.error(err);
  }
}

function mkGrad(ctx,c1,c2) { const g=ctx.createLinearGradient(0,0,0,240); g.addColorStop(0,c1); g.addColorStop(1,c2); return g; }

function renderTrendChart(daily, wtype) {
  destroyChart('trend');
  const canvas=document.getElementById('analytics-trend-chart'); if(!canvas)return;
  const ctx=canvas.getContext('2d');
  chartInstances['trend']=new Chart(ctx,{
    type:'line',
    data:{labels:Object.keys(daily),datasets:[{label:wtype==='hazardous'?'Volume (kg)':'Entries',data:Object.values(daily),backgroundColor:mkGrad(ctx,'rgba(211,47,47,0.55)','rgba(211,47,47,0.02)'),borderColor:'#d32f2f',borderWidth:2.5,fill:true,tension:0.42,pointBackgroundColor:'#d32f2f',pointRadius:4,pointHoverRadius:7}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(0,0,0,0.8)',padding:12,cornerRadius:8}},scales:{x:{grid:{display:false},ticks:{color:'#666',font:{size:11}}},y:{grid:{color:'rgba(0,0,0,0.06)'},ticks:{color:'#666',font:{size:11}},beginAtZero:true}}}
  });
}

function renderBreakdownChart(wc) {
  destroyChart('breakdown');
  const canvas=document.getElementById('analytics-breakdown-chart'); if(!canvas)return;
  const sorted=Object.entries(wc).sort((a,b)=>b[1]-a[1]);
  const pal=['#d32f2f','#ef5350','#ff7043','#ff8a65','#ffab40','#ffd54f','#aed581','#4db6ac'];
  chartInstances['breakdown']=new Chart(canvas.getContext('2d'),{
    type:'bar',
    data:{labels:sorted.map(([k])=>k.length>22?k.slice(0,20)+'…':k),datasets:[{data:sorted.map(([,v])=>v),backgroundColor:pal.slice(0,sorted.length),borderRadius:6,borderSkipped:false}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(0,0,0,0.8)',padding:12,cornerRadius:8}},scales:{x:{grid:{color:'rgba(0,0,0,0.06)'},ticks:{color:'#666'},beginAtZero:true},y:{grid:{display:false},ticks:{color:'#666',font:{size:11}}}}}
  });
}

function renderContributors(uc) {
  const el=document.getElementById('analytics-contributors'); if(!el)return;
  const sorted=Object.entries(uc).sort((a,b)=>b[1]-a[1]).slice(0,5), max=sorted[0]?.[1]||1;
  el.innerHTML=sorted.map(([email,count])=>`
    <div class="contributor-row">
      <div class="contributor-avatar">${email.split('@')[0].slice(0,2).toUpperCase()}</div>
      <div class="contributor-info">
        <div class="contributor-email">${email}</div>
        <div class="contributor-bar-wrap"><div class="contributor-bar" style="width:${((count/max)*100).toFixed(0)}%"></div></div>
      </div>
      <div class="contributor-count">${count}</div>
    </div>`).join('');
}

// ═══════════════════════════════════════════════════════════════════════════
// ANALYTICS PDF EXPORT
// ═══════════════════════════════════════════════════════════════════════════

async function generateAnalyticsPDF() {
  const data = window.lastAnalyticsData;
  if (!data) { showToast('Load analytics first', 'error'); return; }

  const btn = document.getElementById('analytics-pdf-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const m  = 15, cw = pw - m * 2;

    const { dr, wc, uc, daily, tv, tw, wtype, pkg, periodLabel } = data;

    // ── Header ────────────────────────────────────────────────────────────
    doc.setFillColor(211, 47, 47);
    doc.rect(0, 0, pw, 44, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');   doc.setFontSize(17);
    doc.text('HDJV Waste Management System', m, 14);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.text((wtype === 'hazardous' ? 'Hazardous' : 'Solid') + ' Waste Analytics — Package ' + pkg.replace('P', ''), m, 24);
    doc.setFontSize(8);
    doc.text('Period: ' + periodLabel, m, 32);
    doc.text('Generated: ' + new Date().toLocaleString(), m, 39);

    // ── KPI Summary ───────────────────────────────────────────────────────
    const avgPerDay = (dr.length / (window._analyticsDays || 30)).toFixed(1);
    doc.setFillColor(249, 249, 249); doc.setDrawColor(230, 230, 230);
    doc.roundedRect(m, 50, cw, 28, 3, 3, 'FD');
    [
      ['TOTAL ENTRIES', String(dr.length)],
      [wtype === 'hazardous' ? 'TOTAL VOLUME (kg)' : 'TOTAL ENTRIES', wtype === 'hazardous' ? tv.toFixed(2) : String(dr.length)],
      ['TOP WASTE TYPE', tw ? tw[0].slice(0, 18) : '—'],
      ['AVG / DAY', avgPerDay]
    ].forEach(([lbl, val], i) => {
      const x = m + i * (cw / 4) + 4;
      doc.setFontSize(6.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(120, 120, 120);
      doc.text(lbl, x, 59);
      doc.setFontSize(11); doc.setTextColor(211, 47, 47);
      doc.text(val, x, 69);
    });

    // ── Waste Breakdown Table ─────────────────────────────────────────────
    let y = 87;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(40, 40, 40);
    doc.text('Waste Type Breakdown', m, y); y += 7;

    const sorted = Object.entries(wc).sort((a, b) => b[1] - a[1]);
    const total  = sorted.reduce((s, [, v]) => s + v, 0);

    // Table header
    doc.setFillColor(211, 47, 47);
    doc.rect(m, y, cw, 7, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    doc.text('Waste Type', m + 3, y + 5);
    doc.text('Count', m + cw - 44, y + 5);
    doc.text('%', m + cw - 18, y + 5);
    y += 7;

    sorted.forEach(([name, count], idx) => {
      if (y > ph - 20) {
        drawAnalyticsFooter(doc, ph, m, pw);
        doc.addPage(); y = 20;
      }
      doc.setFillColor(idx % 2 === 0 ? 255 : 248, idx % 2 === 0 ? 255 : 248, idx % 2 === 0 ? 255 : 250);
      doc.rect(m, y, cw, 7, 'F');
      doc.setDrawColor(235, 235, 235); doc.line(m, y + 7, m + cw, y + 7);
      doc.setTextColor(50, 50, 50); doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      // Bar indicator
      const barW = Math.max(1, (count / sorted[0][1]) * 40);
      doc.setFillColor(211, 47, 47, 0.15);
      doc.setFillColor(255, 220, 220);
      doc.rect(m + 3, y + 1.5, barW, 4, 'F');
      doc.setTextColor(50, 50, 50);
      doc.text(name.length > 38 ? name.slice(0, 37) + '…' : name, m + 3, y + 5.2);
      doc.text(String(count), m + cw - 44, y + 5.2);
      doc.text(((count / total) * 100).toFixed(1) + '%', m + cw - 18, y + 5.2);
      y += 7;
    });

    y += 8;

    // ── Top Contributors Table ────────────────────────────────────────────
    if (y > ph - 60) { drawAnalyticsFooter(doc, ph, m, pw); doc.addPage(); y = 20; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(40, 40, 40);
    doc.text('Top Contributors', m, y); y += 7;

    const ucSorted = Object.entries(uc).sort((a, b) => b[1] - a[1]).slice(0, 10);
    doc.setFillColor(211, 47, 47);
    doc.rect(m, y, cw, 7, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    doc.text('User', m + 3, y + 5);
    doc.text('Entries', m + cw - 20, y + 5);
    y += 7;

    ucSorted.forEach(([email, count], idx) => {
      if (y > ph - 20) { drawAnalyticsFooter(doc, ph, m, pw); doc.addPage(); y = 20; }
      doc.setFillColor(idx % 2 === 0 ? 255 : 248, idx % 2 === 0 ? 255 : 248, idx % 2 === 0 ? 255 : 250);
      doc.rect(m, y, cw, 7, 'F');
      doc.setDrawColor(235, 235, 235); doc.line(m, y + 7, m + cw, y + 7);
      doc.setTextColor(50, 50, 50); doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      doc.text(email, m + 3, y + 5.2);
      doc.text(String(count), m + cw - 20, y + 5.2);
      y += 7;
    });

    // ── Footer on all pages ───────────────────────────────────────────────
    const totalPages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      drawAnalyticsFooter(doc, ph, m, pw, p, totalPages);
    }

    const dateStr = new Date().toISOString().split('T')[0];
    doc.save('analytics_' + pkg + '_' + wtype + '_' + dateStr + '.pdf');
    document.querySelectorAll('.toast').forEach(t => t.remove());
    activeToast = null;
    showToast('Analytics PDF exported!', 'success');

  } catch (err) {
    console.error(err);
    document.querySelectorAll('.toast').forEach(t => t.remove());
    activeToast = null;
    showToast('PDF export failed', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📄 Export PDF'; }
  }
}

function drawAnalyticsFooter(doc, ph, m, pw, page, total) {
  doc.setFillColor(245, 245, 245);
  doc.rect(0, ph - 11, pw, 11, 'F');
  doc.setTextColor(160, 160, 160); doc.setFontSize(7); doc.setFont('helvetica', 'normal');
  doc.text('HDJV Environmental Management — Analytics Report — Confidential', m, ph - 4);
  if (page && total) doc.text('Page ' + page + ' of ' + total, pw - m - 20, ph - 4);
}

// ═══════════════════════════════════════════════════════════════════════════
// IMAGE PREVIEW
// ═══════════════════════════════════════════════════════════════════════════

async function previewImage(event, formType) {
  const file=event.target.files[0]; if(!file)return;
  const sec=`${formType}-form-section`, ud=document.querySelector(`#${sec} .photo-upload`), ph=ud.querySelector('.placeholder');
  let img=ud.querySelector("img"); if(!img){img=document.createElement("img");img.className="photo-preview";ud.appendChild(img);}
  const bmp=await createImageBitmap(file), canvas=document.createElement("canvas");
  const MAX=1280; let w=bmp.width,h=bmp.height; if(w>MAX){h=h*(MAX/w);w=MAX;}
  canvas.width=w; canvas.height=h;
  const ctx=canvas.getContext("2d"); ctx.drawImage(bmp,0,0,w,h);
  const email=localStorage.getItem("userEmail")||"unknown", pkg=selectedPackage||"N/A";
  let text=`HDJV ENVI UNIT\n${new Date().toLocaleString()}\n`;
  try { const pos=await new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(res,rej,{timeout:5000})); text+=`Lat:${pos.coords.latitude.toFixed(6)} Lng:${pos.coords.longitude.toFixed(6)}\n`; } catch{text+=`Lat:N/A Lng:N/A\n`;}
  text+=`User:${email}\nPkg:${pkg}`;
  const lines=text.split("\n"),bfs=Math.max(40,Math.floor(w/28)),blh=bfs*1.5,bp=bfs;
  const calcH=lines.length*blh+bp*2,maxH=canvas.height*0.20,s=calcH>maxH?maxH/calcH:1;
  const fh=calcH>maxH?maxH:calcH,fs=bfs*s,lh=blh*s,pd=bp*s;
  ctx.fillStyle="rgba(0,0,0,0.75)"; ctx.fillRect(0,canvas.height-fh,canvas.width,fh);
  ctx.fillStyle="white"; ctx.font=`bold ${fs}px Arial`; ctx.textBaseline="top";
  lines.forEach((l,i)=>ctx.fillText(l,pd,canvas.height-fh+pd+i*lh));
  const final=canvas.toDataURL("image/jpeg",0.85);
  compressedImageBase64=final; img.src=final; img.style.display='block';
  ud.classList.add("has-image"); if(ph) ph.style.display="none";
}

// ═══════════════════════════════════════════════════════════════════════════
// FORM SUBMISSIONS
// ═══════════════════════════════════════════════════════════════════════════

async function addEntry(t) { if(t==='hazardous')await addHazardousEntry();else await addSolidEntry(); }

async function addHazardousEntry() {
  document.querySelectorAll('#hazardous-form-section .form-group').forEach(g=>g.classList.remove('error'));
  const date=document.getElementById('hazardous-date').value, volume=document.getElementById('hazardous-volume').value,
        waste=document.getElementById('hazardous-waste').value, photo=document.getElementById('hazardous-photo').files[0];
  let err=false;
  if(!date)  {document.getElementById('hazardous-date-group').classList.add('error');err=true;}
  if(!volume){document.getElementById('hazardous-volume-group').classList.add('error');err=true;}
  if(!waste) {document.getElementById('hazardous-waste-group').classList.add('error');err=true;}
  if(!photo) {document.getElementById('hazardous-photo-group').classList.add('error');err=true;}
  if(err){showToast('Fill in all required fields','error');return;}
  await submitEntry('hazardous',{date,volume,waste,photo},document.getElementById('hazardous-submitBtn'));
}

async function addSolidEntry() {
  document.querySelectorAll('#solid-form-section .form-group').forEach(g=>g.classList.remove('error'));
  const date=document.getElementById('solid-date').value, locNum=document.getElementById('solid-location').value,
        waste=document.getElementById('solid-waste').value, photo=document.getElementById('solid-photo').files[0];
  let err=false;
  if(!date)  {document.getElementById('solid-date-group').classList.add('error');err=true;}
  if(!locNum||locNum<462||locNum>1260){document.getElementById('solid-location-group').classList.add('error');err=true;}
  if(!waste) {document.getElementById('solid-waste-group').classList.add('error');err=true;}
  if(!photo) {document.getElementById('solid-photo-group').classList.add('error');err=true;}
  if(err){showToast('Fill in all required fields','error');return;}
  await submitEntry('solid',{date,location:`P-${locNum}`,waste,photo},document.getElementById('solid-submitBtn'));
}

async function submitEntry(type, fields, btn) {
  const fpKey = type==='hazardous'
    ? `${selectedPackage}-hazardous-${fields.date}-${fields.volume}-${fields.waste}`
    : `${selectedPackage}-solid-${fields.date}-${fields.location}-${fields.waste}`;
  const check=isSubmissionCompleted(fpKey);
  if(check.completed){showToast(`Already submitted ${check.hoursSince}h ago`,'error');return;}
  const now=Date.now();
  for(const[k,v]of submissionFingerprints)if(now-v>FINGERPRINT_LOCK_DURATION)submissionFingerprints.delete(k);
  if(submissionFingerprints.has(fpKey)){showToast('Submission in progress…','error');return;}
  submissionFingerprints.set(fpKey,now);
  btn.disabled=true; btn.textContent='Submitting…';
  const reqId=generateRequestId(fpKey); activeSubmissions.add(reqId);
  showToast('Uploading…','info',{persistent:true,spinner:true});
  try {
    const email=localStorage.getItem("userEmail")||"Unknown";
    const wm=await stampImageWithWatermark(fields.photo,email,selectedPackage);
    const payload={requestId:reqId,token:localStorage.getItem("userToken"),package:selectedPackage,wasteType:type,...fields,imageByte:wm.split(',')[1],imageName:`${selectedPackage}_${type}_${Date.now()}.jpg`};
    delete payload.photo;
    const ctrl=new AbortController(); setTimeout(()=>ctrl.abort(),30000);
    const res=await authenticatedFetch(scriptURL,{method:'POST',body:JSON.stringify(payload),signal:ctrl.signal});
    const data=await res.json();
    if(activeToast)dismissToast(activeToast);
    if(data.success||data.error==='Duplicate request'){markSubmissionAsCompleted(fpKey);showToast('Entry submitted!','success');resetForm(type);}
    else{setTimeout(()=>submissionFingerprints.delete(fpKey),30000);showToast(data.error||'Failed','error');}
  } catch(e) {
    if(activeToast)dismissToast(activeToast);
    setTimeout(()=>submissionFingerprints.delete(fpKey),60000);
    showToast(e.name==='AbortError'?'Timeout — check history':'Error — check history','error');
  } finally { activeSubmissions.delete(reqId); btn.disabled=false; btn.textContent='Submit Entry'; }
}

function resetForm(type) {
  const ids=type==='hazardous'?['hazardous-date','hazardous-volume','hazardous-waste','hazardous-photo']:['solid-date','solid-location','solid-waste','solid-photo'];
  ids.forEach(id=>document.getElementById(id).value='');
  const ud=document.querySelector(`#${type}-form-section .photo-upload`);
  const img=ud.querySelector('.photo-preview'), ph=ud.querySelector('.placeholder');
  if(img)img.remove(); if(ph)ph.style.display='flex'; ud.classList.remove('has-image');
  document.getElementById(`${type}-date`).valueAsDate=new Date();
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. HISTORY WITH FILTERS
// ═══════════════════════════════════════════════════════════════════════════

async function loadHistory(type) {
  const from=document.getElementById(`${type}-fromDate`).value, to=document.getElementById(`${type}-toDate`).value;
  const wf=document.getElementById(`${type}-filter-waste`)?.value||'';
  if(!from||!to){showToast('Select a date range','error');return;}
  if(!selectedPackage){showToast('No package selected','error');return;}
  if((new Date(to)-new Date(from))/86400000>31){showToast('Max 31-day range','error');return;}

  document.getElementById(`${type}-loading`).style.display='block';
  document.getElementById(`${type}-table-container`).style.display='none';
  document.getElementById(`${type}-empty-state`).style.display='none';

  try {
    const res=await authenticatedFetch(`${scriptURL}?package=${selectedPackage}&wasteType=${type}&from=${from}&to=${to}`);
    const rows=await res.json();
    if(type==='hazardous')window.loadedHazardousRows=rows; else window.loadedSolidRows=rows;
    document.getElementById(`${type}-loading`).style.display='none';
    if(rows.error){showToast(rows.error,'error');document.getElementById(`${type}-empty-state`).style.display='block';return;}
    if(rows.length<=1){document.getElementById(`${type}-empty-state`).style.display='block';return;}
    let dr=rows.slice(1);
    if(wf) dr=dr.filter(r=>(r[2]||'').toLowerCase().includes(wf.toLowerCase()));
    if(!dr.length){document.getElementById(`${type}-empty-state`).style.display='block';return;}
    document.getElementById(`${type}-table-container`).style.display='block';
    document.getElementById(`${type}-exportBtn`).disabled=false;
    document.getElementById(`${type}-pdfBtn`).disabled=false;
    const tb=document.getElementById(`${type}-table-body`); tb.innerHTML='';
    dr.forEach(r=>{
      const date=new Date(r[0]).toLocaleDateString("en-US",{year:"numeric",month:"short",day:"numeric"});
      let img=''; if(r[5]){const m=r[5].match(/\/d\/([^/]+)/);img=m?`https://drive.google.com/uc?export=view&id=${m[1]}`:r[5];}
      const link=img?`<a class="photo-link" onclick="openImageModal('${img}')">View</a>`:'—';
      const tr=document.createElement("tr"); tr.innerHTML=`<td>${date}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[4]}</td><td>${link}</td>`; tb.appendChild(tr);
    });
  } catch(err){document.getElementById(`${type}-loading`).style.display='none';showToast('Error loading data','error');console.error(err);}
}

// ═══════════════════════════════════════════════════════════════════════════
// EXCEL EXPORT
// ═══════════════════════════════════════════════════════════════════════════

async function exportExcel(type) {
  const rows=type==='hazardous'?window.loadedHazardousRows:window.loadedSolidRows;
  const btn=document.getElementById(`${type}-exportBtn`);
  if(!rows||rows.length<=1){showToast("No data","error");return;}
  btn.disabled=true;btn.textContent="Exporting…";
  try {
    const exp=JSON.parse(JSON.stringify(rows));
    exp[0]=type==='hazardous'?["Date","Volume (kg)","Waste","Package","User","Photo","Timestamp"]:["Date","Location","Waste","Package","User","Photo","Timestamp"];
    for(let i=1;i<exp.length;i++){exp[i][0]=new Date(exp[i][0]).toLocaleDateString("en-US");if(exp[i][6])exp[i][6]=new Date(exp[i][6]).toLocaleString("en-US");}
    const ws=XLSX.utils.aoa_to_sheet(exp); ws["!cols"]=[{wch:15},{wch:15},{wch:40},{wch:15},{wch:30},{wch:80},{wch:22}];
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,"Records");
    XLSX.writeFile(wb,`${type}_waste_${selectedPackage}_${new Date().toISOString().split('T')[0]}.xlsx`);
    showToast("Excel exported!","success");
  }catch(e){console.error(e);showToast("Export failed","error");}
  finally{btn.disabled=false;btn.textContent="Export Excel";}
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. PDF REPORT
// ═══════════════════════════════════════════════════════════════════════════

// ── Extract Google Drive file ID from any Drive URL ──────────────────────
function extractDriveId(driveUrl) {
  const m = driveUrl.match(/\/d\/([^/?\s]+)/) || driveUrl.match(/[?&]id=([^&\s]+)/);
  return m ? m[1] : null;
}

// ── Load an image via <img> tag → canvas → base64 ────────────────────────
// This avoids fetch() CORS issues. Drive thumbnail URLs load fine as <img>
// src but can't be read back via fetch. We draw to canvas instead.
// NOTE: canvas.toDataURL() requires the image to load with CORS headers OR
// the image to be served from the same origin. Drive thumbnails do NOT send
// CORS headers, so toDataURL() will throw a "tainted canvas" error.
// Workaround: use a CORS proxy for the thumbnail, or — better — use the
// Apps Script backend as a proxy (since it can fetch Drive files server-side).
// For now we use the fastest client-side approach that works in practice:
// try crossOrigin='anonymous' first, fall back to non-CORS load and catch.

function loadImageViaCanvas(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', 0.85), w: img.naturalWidth, h: img.naturalHeight });
      } catch {
        // Canvas tainted — CORS blocked toDataURL. Return dims only (image displayed but not exportable).
        resolve(null);
      }
    };

    img.onerror = () => resolve(null);

    img.src = url;
  });
}

// ── Fetch image through the GAS backend (proxy) ───────────────────────────
// The Apps Script can fetch Drive files without CORS restrictions and return
// them as base64. We call it with action=getImageBase64&id=<fileId>.
// If the backend doesn't support this action yet, it falls back to null.
async function fetchImageViaProxy(fileId) {
  try {
    const token = localStorage.getItem('userToken');
    const url   = `${scriptURL}?action=getImageBase64&id=${fileId}&token=${token}`;
    const res   = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data  = await res.json();
    if (data.base64 && data.mimeType) {
      return {
        dataUrl: `data:${data.mimeType};base64,${data.base64}`,
        w: data.width  || 800,
        h: data.height || 600
      };
    }
    return null;
  } catch { return null; }
}

// ── Master image resolver — tries multiple strategies ─────────────────────
async function fetchImageAsBase64(driveUrl) {
  if (!driveUrl) return null;
  const id = extractDriveId(driveUrl);
  if (!id) return null;

  // Strategy 1: GAS proxy (most reliable, works if backend supports it)
  const proxy = await fetchImageViaProxy(id);
  if (proxy) return proxy;

  // Strategy 2: Drive thumbnail with crossOrigin='anonymous'
  const thumbUrl = `https://drive.google.com/thumbnail?id=${id}&sz=w800`;
  const thumb    = await loadImageViaCanvas(thumbUrl);
  if (thumb) return thumb;

  // Strategy 3: uc?export=view (direct download link)
  const viewUrl = `https://drive.google.com/uc?export=view&id=${id}`;
  const view    = await loadImageViaCanvas(viewUrl);
  if (view) return view;

  return null;
}

// ── Measure image dimensions from a data-URL ─────────────────────────────
function getImageDimensions(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload  = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 1, h: 1 });
    img.src = dataUrl;
  });
}

// ── Main PDF generator ────────────────────────────────────────────────────
async function generatePDFReport(type) {
  const rows = type === 'hazardous' ? window.loadedHazardousRows : window.loadedSolidRows;
  if (!rows || rows.length <= 1) { showToast("No data for PDF", "error"); return; }

  const btn = document.getElementById(`${type}-pdfBtn`);
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }

  // Show a persistent toast while images are being fetched
  showToast('Fetching images… this may take a moment', 'info', { persistent: true, spinner: true });

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pw = doc.internal.pageSize.getWidth();   // 210 mm
    const ph = doc.internal.pageSize.getHeight();  // 297 mm
    const m  = 15;                                  // margin
    const cw = pw - m * 2;                          // content width = 180 mm

    // ── Column layout ─────────────────────────────────────────────────────
    // Date | Vol/Loc | Waste | Logged By | Photo
    // widths in mm: 30, 22, 52, 36, 40  (total = 180)
    const cols = [30, 22, 52, 36, 40];
    const hdrs = type === 'hazardous'
      ? ['Date', 'Vol (kg)', 'Waste Type', 'Logged By', 'Photo']
      : ['Date', 'Location', 'Waste Type', 'Logged By', 'Photo'];

    // Photo cell size: 3.5" × 2" landscape or 2" × 3.5" portrait (1 inch = 25.4 mm)
    // We auto-detect per image and fit inside the cell:
    //   cell width  = cols[4] mm = 40 mm ≈ 1.57" — we'll use it as max width
    //   cell height = row height — driven by image
    // Target: if image is landscape → render at 40mm wide, height = 40*(2/3.5) ≈ 22.9mm
    //         if image is portrait  → render at 40mm wide, height = 40*(3.5/2) = 70mm
    // We cap portrait at 60mm so rows stay manageable.
    const IMG_W       = cols[4] - 2;   // mm, image width inside cell (38mm)
    const ROW_H_TEXT  = 9;             // mm, row height when no image / failed image
    const ROW_PAD     = 2;             // mm, padding inside image row

    // ─── Pre-fetch all images ─────────────────────────────────────────────
    const dr = rows.slice(1);
    const imageCache = []; // per-row: { dataUrl, imgW, imgH, rowH } or null

    for (let i = 0; i < dr.length; i++) {
      const r       = dr[i];
      const rawUrl  = r[5] || '';
      if (!rawUrl) { imageCache.push(null); continue; }

      const result = await fetchImageAsBase64(rawUrl);
      if (!result) { imageCache.push(null); continue; }

      const { dataUrl, w: natW, h: natH } = result;
      const isLandscape = natW >= natH;

      let imgW, imgH;
      if (isLandscape) {
        // Fit to cell width, maintain 3.5:2 aspect (or actual ratio)
        imgW = IMG_W;
        imgH = imgW * (natH / natW);
        // Cap height: 2" = 50.8mm  (landscape target is ~22–25mm so this is plenty)
        imgH = Math.min(imgH, 50.8);
      } else {
        // Portrait: fit to cell width, target 2:3.5 aspect
        imgW = IMG_W;
        imgH = imgW * (natH / natW);
        // Cap at 3.5" = 88.9mm, but cap practically at 70mm
        imgH = Math.min(imgH, 70);
      }

      const rowH = imgH + ROW_PAD * 2;
      imageCache.push({ dataUrl, imgW, imgH, rowH, isLandscape });
    }

    // ─── Dismiss the fetching toast ───────────────────────────────────────
    if (activeToast) dismissToast(activeToast);
    showToast('Building PDF…', 'info', { persistent: true, spinner: true });

    // ─── Header ──────────────────────────────────────────────────────────
    const drawHeader = () => {
      doc.setFillColor(211, 47, 47);
      doc.rect(0, 0, pw, 40, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');   doc.setFontSize(17);
      doc.text('HDJV Waste Management System', m, 15);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.text(`${type === 'hazardous' ? 'Hazardous' : 'Solid'} Waste Report — Package ${selectedPackage.replace('P', '')}`, m, 24);
      doc.setFontSize(8);
      doc.text(`Generated: ${new Date().toLocaleString()}`, m, 32);
    };
    drawHeader();

    // ─── Summary KPI box ─────────────────────────────────────────────────
    let tv = 0; const wc = {};
    dr.forEach(r => {
      tv += type === 'hazardous' ? parseFloat(r[1]) || 0 : 1;
      wc[r[2] || 'Unknown'] = (wc[r[2] || 'Unknown'] || 0) + 1;
    });
    const tw = Object.entries(wc).sort((a, b) => b[1] - a[1])[0];

    doc.setFillColor(249, 249, 249); doc.setDrawColor(230, 230, 230);
    doc.roundedRect(m, 47, cw, 26, 3, 3, 'FD');
    [
      ['TOTAL ENTRIES', String(dr.length)],
      [type === 'hazardous' ? 'VOLUME (kg)' : 'ENTRIES', type === 'hazardous' ? tv.toFixed(2) : String(dr.length)],
      ['TOP WASTE', tw ? tw[0].slice(0, 20) : '—']
    ].forEach(([lbl, val], i) => {
      const x = m + i * (cw / 3) + 8;
      doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(120, 120, 120); doc.text(lbl, x, 55);
      doc.setFontSize(12); doc.setTextColor(211, 47, 47); doc.text(val, x, 65);
    });

    // ─── Table header row ─────────────────────────────────────────────────
    const drawTableHeader = (yPos) => {
      doc.setFillColor(211, 47, 47);
      doc.rect(m, yPos, cw, 8, 'F');
      doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
      let xp = m + 2;
      hdrs.forEach((h, i) => { doc.text(h, xp, yPos + 5.5); xp += cols[i]; });
    };

    let y = 84;
    drawTableHeader(y);
    y += 8;

    // ─── Data rows ────────────────────────────────────────────────────────
    dr.forEach((r, idx) => {
      const imgInfo = imageCache[idx];
      const rowH    = imgInfo ? imgInfo.rowH : ROW_H_TEXT;

      // Page break check
      if (y + rowH > ph - 14) {
        // Footer on current page first
        drawPageFooter(doc, ph, m, pw);
        doc.addPage();
        drawHeader();
        y = 47; // start table right after compact header on continuation pages
        drawTableHeader(y);
        y += 8;
      }

      // Row background
      doc.setFillColor(
        idx % 2 === 0 ? 255 : 248,
        idx % 2 === 0 ? 255 : 248,
        idx % 2 === 0 ? 255 : 250
      );
      doc.rect(m, y, cw, rowH, 'F');
      doc.setDrawColor(235, 235, 235);
      doc.line(m, y + rowH, m + cw, y + rowH);

      // Text cells (cols 0–3)
      doc.setTextColor(50, 50, 50); doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      const textY = y + (rowH > ROW_H_TEXT ? ROW_PAD + 5 : 5.5); // align near top of tall rows
      const cells = [
        new Date(r[0]).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
        String(r[1] || ''),
        String(r[2] || ''),
        String(r[4] || '')
      ];
      let xr = m + 2;
      cells.forEach((c, i) => {
        // Use splitTextToSize for wrapping — shows full text without truncation
        const maxW = cols[i] - 3; // leave 3mm padding
        const lines = doc.splitTextToSize(String(c), maxW);
        // For tall rows (with images), print up to 3 lines; for text rows up to 2
        const maxLines = rowH > ROW_H_TEXT ? 3 : 2;
        lines.slice(0, maxLines).forEach((ln, li) => {
          doc.text(ln, xr, textY + li * 3.5);
        });
        xr += cols[i];
      });

      // Photo cell
      const photoX = m + cols[0] + cols[1] + cols[2] + cols[3]; // x start of photo column
      if (imgInfo) {
        // Center image horizontally in the photo column
        const offsetX = photoX + (cols[4] - imgInfo.imgW) / 2;
        const offsetY = y + ROW_PAD;
        // Draw a subtle border around the photo
        doc.setDrawColor(200, 200, 200);
        doc.rect(offsetX - 0.5, offsetY - 0.5, imgInfo.imgW + 1, imgInfo.imgH + 1, 'S');
        doc.addImage(imgInfo.dataUrl, 'JPEG', offsetX, offsetY, imgInfo.imgW, imgInfo.imgH);
      } else {
        // No image placeholder text
        doc.setTextColor(180, 180, 180); doc.setFontSize(7);
        doc.text('No image', photoX + 2, y + (rowH / 2) + 2);
        doc.setTextColor(50, 50, 50); doc.setFontSize(8);
      }

      y += rowH;
    });

    // ─── Footer on last page ──────────────────────────────────────────────
    const totalPages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      drawPageFooter(doc, ph, m, pw, p, totalPages);
    }

    doc.save(`${type}_report_${selectedPackage}_${new Date().toISOString().split('T')[0]}.pdf`);
    // Dismiss any lingering toasts (Fetching... / Building PDF...)
    document.querySelectorAll('.toast').forEach(t => t.remove());
    activeToast = null;
    showToast('PDF generated!', 'success');

  } catch (e) {
    console.error(e);
    document.querySelectorAll('.toast').forEach(t => t.remove());
    activeToast = null;
    showToast('PDF generation failed — see console', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📄 PDF'; }
  }
}

function drawPageFooter(doc, ph, m, pw, page, total) {
  doc.setFillColor(245, 245, 245);
  doc.rect(0, ph - 11, pw, 11, 'F');
  doc.setTextColor(160, 160, 160); doc.setFontSize(7); doc.setFont('helvetica', 'normal');
  doc.text('HDJV Environmental Management — Confidential', m, ph - 4);
  if (page && total) doc.text(`Page ${page} of ${total}`, pw - m - 20, ph - 4);
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTH / UI
// ═══════════════════════════════════════════════════════════════════════════

function parseJwt(t){const b=t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');return JSON.parse(decodeURIComponent(atob(b).split('').map(c=>'%'+('00'+c.charCodeAt(0).toString(16)).slice(-2)).join('')));}

function displayUserInfo(name, role) {
  const ui=document.getElementById('user-info'),un=document.getElementById('user-name'),rb=document.getElementById('user-role-badge'),mt=document.getElementById('mode-toggle');
  if(!ui||!un||!rb)return;
  un.textContent=name;
  if(role==='super_admin'){rb.textContent='SUPER ADMIN';rb.className='role-badge super_admin';}
  else if(role==='admin'){rb.textContent='ADMIN';rb.className='role-badge admin';}
  else{rb.textContent='USER';rb.className='role-badge';}
  if((role==='admin'||role==='super_admin')&&mt){mt.style.display='flex';updateModeLabels(false);}
  ui.style.display='flex';
}

function toggleAdminMode(){const on=document.getElementById('admin-mode-toggle').checked;if(on){showSection('admin-dashboard');showToast('Admin mode','info');}else{showSection('package-section');showToast('User mode','info');}}
function updateModeLabels(on){document.getElementById('mode-label-user')?.classList[on?'remove':'add']('active');document.getElementById('mode-label-admin')?.classList[on?'add':'remove']('active');}
function updateToggleState(id){const t=document.getElementById('admin-mode-toggle');if(!t)return;const admin=['admin-dashboard','user-management-section','request-logs-section','analytics-section'].includes(id);t.checked=admin;updateModeLabels(admin);}
function enableAdminUI(){document.body.classList.add("is-admin");const mt=document.getElementById('mode-toggle');if(mt)mt.style.display='flex';}

async function logout(){
  if(!confirm('Sign out?'))return;
  showToast('Signing out…','info',{persistent:true});
  try{await authenticatedFetch(`${scriptURL}?action=logout`);}catch{}
  ['userToken','tokenExpiry','userRole','userEmail','completedSubmissions'].forEach(k=>localStorage.removeItem(k));
  document.body.classList.remove('is-admin');
  const ui=document.getElementById('user-info');if(ui)ui.style.display='none';
  if(sessionCheckTimer){clearInterval(sessionCheckTimer);sessionCheckTimer=null;}
  stopTokenRefreshTimer();stopNotifPolling();
  if(window.google?.accounts?.id)google.accounts.id.disableAutoSelect();
  showSection('login-section');
  setTimeout(()=>location.reload(),500);
}

async function handleCredentialResponse(response){
  setLoginLoading(true);
  const pl=parseJwt(response.credential),email=pl.email.toLowerCase(),name=pl.name;
  try{
    const res=await fetch(`${scriptURL}?email=${encodeURIComponent(email)}`),data=await res.json();
    setLoginLoading(false);
    if(data.status==="Approved"){
      localStorage.setItem("userToken",data.token);localStorage.setItem("userRole",data.role||"user");
      localStorage.setItem("userEmail",email);localStorage.setItem("tokenExpiry",data.tokenExpiry);
      const prefs=JSON.parse(localStorage.getItem('userPrefs')||'{}');
      if(prefs.defaultPackage)selectedPackage=prefs.defaultPackage;
      applyTheme(prefs.theme||'default');
      displayUserInfo(name,data.role||"user");
      showToast(`Welcome, ${name}!`,"success");
      showSection("package-section");startSessionMonitoring();
      if(data.role==="admin"||data.role==="super_admin"){enableAdminUI();initNotifications();}
    }else if(data.status==="Rejected"){showToast("Access denied","error");}
    else{showToast("Awaiting admin approval","info");}
  }catch(e){console.error(e);setLoginLoading(false);showToast("Connection error","error");}
}

window.onload=async function(){
  if(DEV_MODE){localStorage.setItem("userToken","DEV_TOKEN");document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));document.getElementById('package-section').classList.add('active');showToast('Dev mode','info');return;}
  const token=localStorage.getItem('userToken'),email=localStorage.getItem('userEmail'),role=localStorage.getItem('userRole');
  if(token&&email){
    const valid=await validateSession();
    if(valid){
      const prefs=JSON.parse(localStorage.getItem('userPrefs')||'{}');
      if(prefs.defaultPackage)selectedPackage=prefs.defaultPackage;
      applyTheme(prefs.theme||'default');
      displayUserInfo(email.split('@')[0],role||'user');
      showSection('package-section');
      if(role==='admin'||role==='super_admin'){enableAdminUI();initNotifications();}
      startSessionMonitoring();
      showToast(`Welcome back! ${Math.floor(getTimeUntilExpiry()/60)}h left`,'success');
      return;
    }
  }
  if(window.google?.accounts?.id){
    google.accounts.id.initialize({client_id:"648943267004-cgsr4bhegtmma2jmlsekjtt494j8cl7f.apps.googleusercontent.com",callback:handleCredentialResponse,auto_select:false,cancel_on_tap_outside:true});
    google.accounts.id.renderButton(document.getElementById("buttonDiv"),{theme:"outline",size:"large",width:"250"});
  }else{showToast('Login service unavailable','error');}
};

function openImageModal(url){const m=url.match(/[-\w]{25,}/);if(!m){showToast("Invalid link","error");return;}document.getElementById("modalImage").src=`https://drive.google.com/thumbnail?id=${m[0]}&sz=w1200`;document.getElementById("imageModal").style.display="flex";}
function closeImageModal(){document.getElementById("imageModal").style.display="none";document.getElementById("modalImage").src="";}
