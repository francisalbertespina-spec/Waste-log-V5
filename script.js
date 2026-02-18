let loadedRows = [];
let selectedPackage = "";
let compressedImageBase64 = "";
let pendingRequestId = null;
let toastQueue = [];
let activeToast = null;
let toastTimer = null;
let selectedWasteType = "";
window.isUploading = false;

// ENHANCED Duplicate submission prevention - AGGRESSIVE MODE
let activeSubmissions = new Set(); // Track active request IDs
let submissionFingerprints = new Map(); // Track ALL attempts (success OR in-progress)
const FINGERPRINT_LOCK_DURATION = 120000; // 2 minutes lock - prevents ANY resubmission

// ═══════════════════════════════════════════════════════════════════════════
// CENTRALIZED FETCH WITH 401 HANDLING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Authenticated fetch wrapper with automatic 401 handling
 * Automatically adds token to requests and handles auth failures
 */
async function authenticatedFetch(url, options = {}) {
  const token = localStorage.getItem('userToken');
  
  // If no token and not a login request, fail immediately
  if (!token && !url.includes('email=')) {
    console.log('❌ No token available');
    handleSessionExpired();
    throw new Error('No authentication token');
  }
  
  // Add token to URL if not already present (for GET requests)
if (token && !url.includes('token=')) {
  const separator = url.includes('?') ? '&' : '?';
  url = `${url}${separator}token=${token}`;
}
  
  // Add token to POST body if applicable
  if (options.method === 'POST' && options.body) {
    try {
      const body = JSON.parse(options.body);
      if (!body.token && token) {
        body.token = token;
        options.body = JSON.stringify(body);
      }
    } catch (e) {
      // Body is not JSON, skip
    }
  }
  
  try {
    const response = await fetch(url, options);
    
    // Handle 401 Unauthorized
    if (response.status === 401) {
      console.log('🚫 401 Unauthorized - session expired');
      
      // Parse response to show specific error if available
      try {
        const data = await response.json();
        if (data.message && data.message !== 'Unauthorized') {
          showToast(data.message, 'error');
        }
      } catch (e) {
        // Ignore parse errors
      }
      
      handleSessionExpired();
      throw new Error('Unauthorized');
    }
    
    // Handle 403 Forbidden (e.g., not admin)
    if (response.status === 403) {
      console.log('🚫 403 Forbidden - insufficient permissions');
      showToast('You do not have permission to perform this action', 'error');
      throw new Error('Forbidden');
    }
    
    // Handle 429 Rate Limit
    if (response.status === 429) {
      console.log('⚠️ 429 Rate Limit Exceeded');
      showToast('Too many requests - please wait a moment', 'error');
      throw new Error('Rate limit exceeded');
    }
    
    // Handle 500 Server Error
    if (response.status === 500) {
      console.log('💥 500 Server Error');
      showToast('Server error - please try again', 'error');
      throw new Error('Server error');
    }
    
    return response;
    
  } catch (error) {
    // Re-throw specific errors
    if (['Unauthorized', 'Forbidden', 'Rate limit exceeded', 'Server error'].includes(error.message)) {
      throw error;
    }
    
    // Handle network errors
    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      console.error('🌐 Network error:', error);
      showToast('Network error - check your connection', 'error');
      throw new Error('Network error');
    }
    
    // Other errors
    console.error('Fetch error:', error);
    throw error;
  }
}

const DEV_MODE = false; // Set to false for production

const scriptURL = "https://script.google.com/macros/s/AKfycbwJBzv06DEAM6QKLFplBU7aUOpMxEAwIE05pDyOVZfbfp9pOCzqrgcrZpg7Sx0-7teO/exec";
// const scriptURL = "https://script.google.com/macros/s/AKfycbxS7wyAfqHKO73Om8h6VCR_M8Pr8FCx79uQP-uQ4PGbb80kyuoNpNjkarWS3UH3_iDy/exec";
// const scriptURL = "https://script.google.com/macros/s/AKfycbyL27Vko3QfF9ENnRUxPAyN1y00Jv-W6VTuverYEVBleLm9pLCCn8V6r00MZK1wMUUe/exec";
// const scriptURL = "https://script.google.com/macros/s/AKfycbwOzLtzZtvR2hrJuS6uVPe58GxATwtwwkSJ_yP073vST9B3283AYd7ADG8ApmPuDKJO/exec";
// Stable V4 - const scriptURL = "https://script.google.com/macros/s/AKfycbxe2nDYZzBT8QCsp_XQa0RaV36c0MMUAYDdrwwGydSs0AbQ1H7RlbGHyE8YSmbhQxk-/exec";

// ═══════════════════════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

const SESSION_CHECK_INTERVAL = 5 * 60 * 1000; // Check every 5 minutes
let sessionCheckTimer = null;

// Check if token is expired
function isTokenExpired() {
  const expiry = localStorage.getItem('tokenExpiry');
  if (!expiry) return true;
  
  const expiryTime = parseInt(expiry);
  const now = Date.now();
  
  return now >= expiryTime;
}

// Get time until token expires (in minutes)
function getTimeUntilExpiry() {
  const expiry = localStorage.getItem('tokenExpiry');
  if (!expiry) return 0;
  
  const expiryTime = parseInt(expiry);
  const now = Date.now();
  const diff = expiryTime - now;
  
  return Math.floor(diff / (1000 * 60)); // Return minutes
}

// Validate token with server
async function validateSession() {
  const token = localStorage.getItem('userToken');
  
  if (!token) {
    handleSessionExpired();
    return false;
  }
  
  // First check local expiry
  if (isTokenExpired()) {
    handleSessionExpired();
    return false;
  }
  
  // Then validate with server
  try {
    const res = await authenticatedFetch(`${scriptURL}?action=validateToken`);
    const data = await res.json();
    
    if (data.valid) {
      if (data.tokenExpiry) {
        localStorage.setItem('tokenExpiry', data.tokenExpiry);
      }
      return true;
    } else {
      handleSessionExpired();
      return false;
    }
  } catch (err) {
    console.error('Session validation error:', err);
    // Don't log out on network error, just return false
    return false;
  }
}

// Handle expired session
function handleSessionExpired() {
  console.log('Session expired');
  
  // Clear all local data
  localStorage.removeItem('userToken');
  localStorage.removeItem('tokenExpiry');
  localStorage.removeItem('userRole');
  localStorage.removeItem('userEmail');
  
  // Reset UI
  document.body.classList.remove('is-admin');
  const userInfo = document.getElementById('user-info');
  if (userInfo) userInfo.style.display = 'none';
  
  // Show login section
  showSection('login-section');
  showToast('Session expired - please sign in again', 'info');
  
  // Stop session checking
  if (sessionCheckTimer) {
    clearInterval(sessionCheckTimer);
    sessionCheckTimer = null;
  }
  // ✨ NEW: Stop token refresh timer
  stopTokenRefreshTimer();
}

// Start periodic session validation
function startSessionMonitoring() {
  // Clear any existing timer
  if (sessionCheckTimer) {
    clearInterval(sessionCheckTimer);
  }
  
  // Check session every 5 minutes
  sessionCheckTimer = setInterval(async () => {
    await validateSession();
  }, SESSION_CHECK_INTERVAL);
  
  // Also check when page becomes visible (user returns to tab)
  document.addEventListener('visibilitychange', async () => {
    if (!document.hidden) {
      await validateSession();
    }
  });
  // ✨ NEW: Start token refresh timer
  startTokenRefreshTimer();
}

// Refresh token (extend session)
async function refreshUserToken() {
  const token = localStorage.getItem('userToken');
  if (!token) return false;
  
  try {
    const res = await authenticatedFetch(`${scriptURL}?action=refreshToken`);
    const data = await res.json();
    
    if (data.success && data.tokenExpiry) {
      localStorage.setItem('tokenExpiry', data.tokenExpiry);
      console.log('Token refreshed successfully');
      return true;
    }
    
    return false;
  } catch (err) {
    console.error('Token refresh error:', err);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTO TOKEN REFRESH
// ═══════════════════════════════════════════════════════════════════════════

let tokenRefreshTimer = null;

/**
 * Automatically refresh token before it expires
 * Checks every 30 minutes, refreshes if < 24 hours remaining
 */
function startTokenRefreshTimer() {
  // Clear any existing timer
  if (tokenRefreshTimer) {
    clearInterval(tokenRefreshTimer);
    tokenRefreshTimer = null;
  }
  
  // Check immediately on start
  checkAndRefreshToken();
  
  // Then check every 30 minutes
  tokenRefreshTimer = setInterval(async () => {
    await checkAndRefreshToken();
  }, 30 * 60 * 1000); // 30 minutes
  
  console.log('✅ Token refresh timer started');
}

async function checkAndRefreshToken() {
  const minutesLeft = getTimeUntilExpiry();
  
  // If expired or no time left, don't try to refresh
  if (minutesLeft <= 0) {
    console.log('❌ Token already expired');
    return;
  }
  
  // If less than 24 hours (1440 minutes) remaining, refresh
  if (minutesLeft < 1440) {
    console.log(`⏰ Token expiring in ${minutesLeft} minutes - refreshing...`);
    
    const success = await refreshUserToken();
    
    if (success) {
      const newMinutesLeft = getTimeUntilExpiry();
      const hoursLeft = Math.floor(newMinutesLeft / 60);
      console.log(`✅ Token refreshed - valid for ${hoursLeft} more hours`);
      showToast(`Session extended for ${Math.floor(hoursLeft / 24)} more days`, 'success', { duration: 2000 });
    } else {
      console.log('❌ Token refresh failed - will expire soon');
      
      // If refresh fails and < 1 hour left, warn user
      if (minutesLeft < 60) {
        showToast('Session expiring soon - please save your work', 'error');
      }
    }
  }
}

function stopTokenRefreshTimer() {
  if (tokenRefreshTimer) {
    clearInterval(tokenRefreshTimer);
    tokenRefreshTimer = null;
    console.log('🛑 Token refresh timer stopped');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// NEW: DUPLICATE PREVENTION HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

// Store successful submissions in localStorage (persists across sessions)
function markSubmissionAsCompleted(fingerprint) {
  const completedSubmissions = JSON.parse(localStorage.getItem('completedSubmissions') || '{}');
  completedSubmissions[fingerprint] = Date.now();
  
  // Keep only last 24 hours of submissions
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const [fp, timestamp] of Object.entries(completedSubmissions)) {
    if (timestamp < oneDayAgo) {
      delete completedSubmissions[fp];
    }
  }
  
  localStorage.setItem('completedSubmissions', JSON.stringify(completedSubmissions));
  console.log('💾 Saved to localStorage:', fingerprint);
}

// Check if submission was already completed
function isSubmissionCompleted(fingerprint) {
  const completedSubmissions = JSON.parse(localStorage.getItem('completedSubmissions') || '{}');
  
  // Check if exists and was within last 24 hours
  if (completedSubmissions[fingerprint]) {
    const timeSinceSubmission = Date.now() - completedSubmissions[fingerprint];
    const hoursSince = Math.floor(timeSinceSubmission / (1000 * 60 * 60));
    return { completed: true, hoursSince };
  }
  
  return { completed: false };
}

// Generate deterministic requestId from fingerprint
function generateRequestId(fingerprint) {
  const today = new Date().toISOString().split('T')[0];
  return `${fingerprint}-${today}`.replace(/[^a-zA-Z0-9-]/g, '_');
}

// ═══════════════════════════════════════════════════════════════════════════

async function stampImageWithWatermark(file, userEmail, selectedPackage) {
  return new Promise((resolve, reject) => {

    if (!navigator.geolocation) {
      alert("GPS not supported");
      return reject("No GPS");
    }

    navigator.geolocation.getCurrentPosition(async pos => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;

      const img = new Image();
      const reader = new FileReader();

      reader.onload = () => {
        img.onload = () => {
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");

          canvas.width = img.width;
          canvas.height = img.height;

          ctx.drawImage(img, 0, 0);

          const now = new Date();
          const pad = n => String(n).padStart(2, "0");
          const timestamp =
            now.getFullYear() + "-" +
            pad(now.getMonth() + 1) + "-" +
            pad(now.getDate()) + " " +
            pad(now.getHours()) + ":" +
            pad(now.getMinutes());

          const watermarkText = `HDJV ENVI UNIT
${timestamp}
Lat: ${lat.toFixed(4)}  Lng: ${lng.toFixed(4)}
User: ${userEmail}
Pkg: ${selectedPackage}`;

          const lines = watermarkText.split("\n");

          // IMPROVED Dynamic sizing
          const baseFontSize = Math.max(40, Math.floor(canvas.width / 28));
          const baseLineHeight = baseFontSize * 1.5;
          const basePadding = baseFontSize * 1.0;
          const calculatedBoxHeight = lines.length * baseLineHeight + basePadding * 2;
          
          // Ensure watermark doesn't exceed 20% of image height
          const maxBoxHeight = canvas.height * 0.20;
          const needsScaling = calculatedBoxHeight > maxBoxHeight;
          
          const finalBoxHeight = needsScaling ? maxBoxHeight : calculatedBoxHeight;
          const scale = needsScaling ? (maxBoxHeight / calculatedBoxHeight) : 1;
          
          const fontSize = baseFontSize * scale;
          const lineHeight = baseLineHeight * scale;
          const padding = basePadding * scale;
          
          // Draw semi-transparent black background
          ctx.fillStyle = "rgba(0,0,0,0.75)";
          ctx.fillRect(0, canvas.height - finalBoxHeight, canvas.width, finalBoxHeight);
          
          // Draw white text
          ctx.fillStyle = "white";
          ctx.font = `bold ${fontSize}px Arial`;
          ctx.textBaseline = "top";
          
          const startY = canvas.height - finalBoxHeight + padding;
          
          lines.forEach((line, i) => {
            const y = startY + (i * lineHeight);
            ctx.fillText(line, padding, y);
          });

          resolve(canvas.toDataURL("image/jpeg", 0.85));
        };

        img.src = reader.result;
      };

      reader.readAsDataURL(file);

    }, err => {
      alert("GPS permission is required.");
      reject(err);
    }, {
      enableHighAccuracy: true,
      timeout: 10000
    });

  });
}


function showToast(message, type = "info", options = {}) {
  const { persistent = false, spinner = false, duration = 3000 } = options;
  toastQueue.push({ message, type, persistent, spinner, duration });
  processToastQueue();
}

function processToastQueue() {
  if (activeToast || toastQueue.length === 0) return;

  const { message, type, persistent, spinner, duration } = toastQueue.shift();
  const icons = { success: "✅", error: "❌", info: "ℹ️" };

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  const iconWrap = document.createElement("div");
  iconWrap.className = "toast-icon";

  if (spinner) {
    const spin = document.createElement("div");
    spin.className = "toast-spinner";
    iconWrap.appendChild(spin);
  } else {
    iconWrap.textContent = icons[type] || "ℹ️";
  }

  toast.appendChild(iconWrap);

  const msg = document.createElement("div");
  msg.className = "toast-message";
  msg.textContent = message;
  toast.appendChild(msg);

  document.body.appendChild(toast);
  activeToast = toast;

  if (!persistent) {
  let timeout = duration || 3000;

    if (type === "error") {
    timeout = 8000; // 🔥 error messages stay 8s
    }

    toastTimer = setTimeout(() => dismissToast(toast), timeout);
  }
}

function dismissToast(toast) {
  if (!toast) return;

  clearTimeout(toastTimer);
  toastTimer = null;

  toast.classList.add("hide");

  setTimeout(() => {
    toast.remove();
    activeToast = null;
    processToastQueue();
  }, 300);
}

function setLoginLoading(isLoading) {
  const btn = document.getElementById("buttonDiv");
  const loadingUI = document.getElementById("loginLoadingUI");

  if (!btn || !loadingUI) return;

  if (isLoading) {
    btn.style.display = "none";
    loadingUI.style.display = "flex";
  } else {
    btn.style.display = "flex";
    loadingUI.style.display = "none";
  }
}

// Section management
// Section management with authentication
function showSection(id) {
  // Define protected sections that require authentication
  const protectedSections = [
    'package-section',
    'waste-type-section',
    'hazardous-menu-section',
    'hazardous-form-section',
    'hazardous-history-section',
    'solid-menu-section',
    'solid-form-section',
    'solid-history-section',
    'admin-dashboard',
    'user-management-section',
    'request-logs-section'
  ];
  
  // Check if section requires authentication
  if (protectedSections.includes(id)) {
    const token = localStorage.getItem('userToken');
    
    // No token or expired token
    if (!token || isTokenExpired()) {
      console.log(`🚫 Blocked access to ${id} - no valid token`);
      handleSessionExpired();
      return;
    }
    
    // Check admin-only sections
    const adminSections = [
      'admin-dashboard',
      'user-management-section',
      'request-logs-section'
    ];
    
    if (adminSections.includes(id)) {
      const role = localStorage.getItem('userRole');
      
      if (role !== 'admin' && role !== 'super_admin') {
        console.log(`🚫 Blocked access to ${id} - not admin`);
        showToast('Admin access required', 'error');
        showSection('package-section');
        return;
      }
    }
  }
  
  // Original code - show the section
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  
  // Update toggle state when section changes
  updateToggleState(id);
  
  // Update breadcrumb package names
  updateBreadcrumbs();
}

// Update breadcrumb package displays
function updateBreadcrumbs() {
  if (selectedPackage) {
    const packageName = `Package ${selectedPackage.replace('P', '')}`;
    
    // Update ALL breadcrumb package references (both hazardous and solid)
    const breadcrumbIds = [
      'current-package', 'waste-type-package',
      'hazardous-menu-package', 'hazardous-form-package', 'hazardous-history-package',
      'solid-menu-package', 'solid-form-package', 'solid-history-package'
    ];
    
    breadcrumbIds.forEach(id => {
      const element = document.getElementById(id);
      if (element) element.textContent = packageName;
    });
  }
}

// Package selection
function selectPackage(pkg, el) {
  document.querySelectorAll('.package-card')
    .forEach(c => c.classList.remove('selected'));

  el.classList.add('selected');
  selectedPackage = pkg;
}

function confirmPackage() {
  if (!selectedPackage) {
    showToast("Please select a package first", "error");
    return;
  }

  updateBreadcrumbs();
  showSection("waste-type-section"); // Changed from "menu-section"
}

function backToPackage() {
  selectedPackage = "";
  document.querySelectorAll('.package-card')
    .forEach(c => c.classList.remove('selected'));
  
  showSection("package-section");
}

function showMenu() {
  showSection('menu-section');
}

function showLogForm(type) {
  if (type === 'hazardous') {
    showSection('hazardous-form-section');
    document.getElementById('hazardous-date').valueAsDate = new Date();
  } else if (type === 'solid') {
    showSection('solid-form-section');
    document.getElementById('solid-date').valueAsDate = new Date();
  }
}

function showHistoryView(type) {
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  
  if (type === 'hazardous') {
    showSection('hazardous-history-section');
    document.getElementById('hazardous-toDate').valueAsDate = today;
    document.getElementById('hazardous-fromDate').valueAsDate = weekAgo;
  } else if (type === 'solid') {
    showSection('solid-history-section');
    document.getElementById('solid-toDate').valueAsDate = today;
    document.getElementById('solid-fromDate').valueAsDate = weekAgo;
  }
}

/* ================= ADMIN FUNCTIONS ================= */

// Admin dashboard navigation
function showUserManagement() {
  showSection("user-management-section");
  loadUsers();
}

function showRequestLogs() {
  showSection("request-logs-section");
  loadRequests();
}

function backToAdminDashboard() {
  showSection("admin-dashboard");
}

function showAdmin() {
  showSection("admin-dashboard");
}

async function loadUsers() {
  try {
    const res = await authenticatedFetch(`${scriptURL}?action=getUsers`);
    const users = await res.json();
    renderUsers(users);
  } catch (e) {
    showToast("Failed to load users", "error");
  }
}

function renderUsers(users) {
  const tbody = document.getElementById("usersTableBody");
  tbody.innerHTML = "";

  if (!users || users.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; padding: 20px; color: #999;">
          No users found
        </td>
      </tr>
    `;
    return;
  }

  // Get current user's email and role
  const currentUserEmail = localStorage.getItem("userEmail");
  const currentUserRole = localStorage.getItem("userRole");
  const isSuperAdmin = currentUserRole === "super_admin";
  const isRegularAdmin = currentUserRole === "admin";

  // Filter users based on role permissions
  let filteredUsers = users;
  if (isRegularAdmin && !isSuperAdmin) {
    // Regular admins can only see pending users and other admins
    filteredUsers = users.filter(u => u.status === 'Pending' || u.role === 'admin');
  }
  // Super admins can see everyone (no filter)

  filteredUsers.forEach(u => {
    const tr = document.createElement("tr");
    
    const isCurrentUser = u.email.toLowerCase() === currentUserEmail.toLowerCase();
    
    // Status dropdown - disabled for regular admins on non-pending users
    const canEditStatus = isSuperAdmin || (isRegularAdmin && u.status === 'Pending');
    const statusOptions = ['Pending', 'Approved', 'Rejected'];
    const statusSelect = `
      <select class="admin-select status-select" 
              value="${u.status}"
              ${canEditStatus ? '' : 'disabled'}
              onchange="updateUserStatus('${u.email}', this.value)">
        ${statusOptions.map(opt => 
          `<option value="${opt}" ${u.status === opt ? 'selected' : ''}>${opt}</option>`
        ).join('')}
      </select>
    `;
    
    // Role dropdown - only super_admin can change roles, and users can't change their own role
    const canEditRole = isSuperAdmin && !isCurrentUser;
    const roleOptions = isSuperAdmin ? ['user', 'admin', 'super_admin'] : ['user', 'admin'];
    const roleSelect = `
      <select class="admin-select role-select" 
              value="${u.role || 'user'}"
              ${canEditRole ? '' : 'disabled'}
              onchange="updateUserRole('${u.email}', this.value)">
        ${roleOptions.map(opt => {
          const optLabel = opt === 'super_admin' ? 'Super Admin' : opt.charAt(0).toUpperCase() + opt.slice(1);
          return `<option value="${opt}" ${(u.role || 'user') === opt ? 'selected' : ''}>${optLabel}</option>`;
        }).join('')}
      </select>
    `;
    
    // Action buttons - regular admins can only approve/reject pending users
    let actions = '';
    if (u.status === 'Pending' && canEditStatus) {
      actions = `
        <button class="btn-action btn-approve" onclick="quickApprove('${u.email}')">
          ✓ Approve
        </button>
        <button class="btn-action btn-reject" onclick="quickReject('${u.email}')">
          ✗ Reject
        </button>
      `;
    } else if (isSuperAdmin && !isCurrentUser) {
      // Only super admin can delete users (except themselves)
      actions = `
        <button class="btn-action btn-delete" onclick="deleteUser('${u.email}')">
          🗑️ Delete
        </button>
      `;
    } else {
      actions = `<span style="color: #999; font-size: 0.85rem;">—</span>`;
    }
    
    tr.innerHTML = `
      <td style="text-align: left;">${u.email}${isCurrentUser ? ' <span style="color: #999; font-size: 0.75rem;">(You)</span>' : ''}</td>
      <td>${statusSelect}</td>
      <td>${roleSelect}</td>
      <td class="action-cell">${actions}</td>
    `;
    tbody.appendChild(tr);
  });
  
  // Apply dynamic styling to all dropdowns after rendering
  applyDropdownStyling();
}

//dropdownnstyling
function applyDropdownStyling() {
  // Style status dropdowns based on selected value
  document.querySelectorAll('.status-select').forEach(select => {
    const value = select.value;
    select.setAttribute('value', value); // Set attribute for CSS selector
  });
  
  // Style role dropdowns based on selected value
  document.querySelectorAll('.role-select').forEach(select => {
    const value = select.value;
    select.setAttribute('value', value); // Set attribute for CSS selector
  });
}


async function approveUser(email) {
  if (!confirm("Approve this user?")) return;

  try {
    await authenticatedFetch(`${scriptURL}?action=approveUser&email=${encodeURIComponent(email)}`);
    loadUsers();
    showToast("User approved", "success");
  } catch (e) {
    showToast("Failed to approve user", "error");
  }
}

async function rejectUser(email) {
  if (!confirm("Reject this user?")) return;

  try {
    await authenticatedFetch(`${scriptURL}?action=rejectUser&email=${encodeURIComponent(email)}`);
    loadUsers();
    showToast("User rejected", "success");
  } catch (e) {
    showToast("Failed to reject user", "error");
  }
}

// Quick approve (for pending users)
async function quickApprove(email) {
  console.log('=== QUICK APPROVE DEBUG ===');
  console.log('1. Email:', email);
  console.log('2. Token:', localStorage.getItem('userToken'));
  console.log('3. User Role:', localStorage.getItem('userRole'));
  
  try {
    const url = `${scriptURL}?action=approveUser&email=${encodeURIComponent(email)}`;
    console.log('4. Request URL:', url);
    
    const res = await authenticatedFetch(url);
    console.log('5. Response status:', res.status);
    
    const data = await res.json();
    console.log('6. Response data:', JSON.stringify(data, null, 2));
    
    if (data.success || data.status === 'success') {
      showToast(`User approved successfully`, "success");
      await loadUsers();
    } else {
      console.error('7. Approval failed:', data);
      showToast(data.message || "Failed to approve user", "error");
    }
  } catch (err) {
    console.error('8. Approve error:', err);
    console.error('Error stack:', err.stack);
    showToast("Error approving user: " + err.message, "error");
  }
}

// Quick reject (for pending users)
async function quickReject(email) {
  console.log('=== QUICK REJECT DEBUG ===');
  console.log('1. Email:', email);
  console.log('2. Token:', localStorage.getItem('userToken'));
  console.log('3. User Role:', localStorage.getItem('userRole'));
  
  try {
    const url = `${scriptURL}?action=rejectUser&email=${encodeURIComponent(email)}`;
    console.log('4. Request URL:', url);
    
    const res = await authenticatedFetch(url);
    console.log('5. Response status:', res.status);
    
    const data = await res.json();
    console.log('6. Response data:', JSON.stringify(data, null, 2));
    
    if (data.success || data.status === 'success') {
      showToast(`User rejected`, "success");
      await loadUsers();
    } else {
      console.error('7. Rejection failed:', data);
      showToast(data.message || "Failed to reject user", "error");
    }
  } catch (err) {
    console.error('8. Reject error:', err);
    console.error('Error stack:', err.stack);
    showToast("Error rejecting user: " + err.message, "error");
  }
}

// Update user status
async function updateUserStatus(email, status) {
  console.log('=== UPDATE STATUS DEBUG ===');
  console.log('1. Email:', email);
  console.log('2. Status:', status);
  console.log('3. Token:', localStorage.getItem('userToken'));
  
  try {
    const action = status === 'Approved' ? 'approveUser' : 
                   status === 'Rejected' ? 'rejectUser' : 'updateUserStatus';
    
    console.log('4. Action:', action);
    
    const url = `${scriptURL}?action=${action}&email=${encodeURIComponent(email)}&status=${status}`;
    console.log('5. Request URL:', url);
    
    const selectElement = (typeof event !== 'undefined' && event?.target) ? event.target : null;
    console.log('6. Select element found:', !!selectElement);
    
    if (selectElement) {
      selectElement.classList.add('loading');
      selectElement.disabled = true;
    }
    
    const res = await authenticatedFetch(url);
    console.log('7. Response status:', res.status);
    
    const data = await res.json();
    console.log('8. Response data:', JSON.stringify(data, null, 2));
    
    if (selectElement) {
      selectElement.classList.remove('loading');
      selectElement.disabled = false;
    }
    
    if (data.success || data.status === 'success') {
      showToast(`Status updated to ${status}`, "success");
      await loadUsers();
    } else {
      console.error('9. Status update failed:', data);
      showToast(data.message || "Failed to update status", "error");
      await loadUsers();
    }
  } catch (err) {
    console.error('10. Status update error:', err);
    console.error('Error stack:', err.stack);
    showToast("Error: " + err.message, "error");
    await loadUsers();
  }
}

// Update user role
async function updateUserRole(email, role) {
  console.log('=== UPDATE ROLE DEBUG ===');
  console.log('1. Email:', email);
  console.log('2. Role:', role);
  console.log('3. Token:', localStorage.getItem('userToken'));
  
  try {
    const url = `${scriptURL}?action=updateUserRole&email=${encodeURIComponent(email)}&role=${role}`;
    console.log('4. Request URL:', url);
    
    const selectElement = (typeof event !== 'undefined' && event?.target) ? event.target : null;
    console.log('5. Select element found:', !!selectElement);
    
    if (selectElement) {
      selectElement.classList.add('loading');
      selectElement.disabled = true;
    }
    
    const res = await authenticatedFetch(url);
    console.log('6. Response status:', res.status);
    
    const data = await res.json();
    console.log('7. Response data:', JSON.stringify(data, null, 2));
    
    if (selectElement) {
      selectElement.classList.remove('loading');
      selectElement.disabled = false;
    }
    
    if (data.success || data.status === 'success') {
      showToast(`Role updated to ${role}`, "success");
      await loadUsers();
    } else {
      console.error('8. Role update failed:', data);
      showToast(data.message || "Failed to update role", "error");
      await loadUsers();
    }
  } catch (err) {
    console.error('9. Role update error:', err);
    console.error('Error stack:', err.stack);
    showToast("Error: " + err.message, "error");
    await loadUsers();
  }
}

// Delete user
async function deleteUser(email) {
  if (!confirm(`Are you sure you want to delete user: ${email}?\n\nThis action cannot be undone.`)) {
    return;
  }
  
  try {
    const url = `${scriptURL}?action=deleteUser&email=${encodeURIComponent(email)}`;
    const res = await authenticatedFetch(url);
    const data = await res.json();
    
    if (data.success || data.status === 'success') {
      showToast("User deleted successfully", "success");
      loadUsers();
    } else {
      showToast(data.message || "Failed to delete user", "error");
    }
  } catch (err) {
    console.error(err);
    showToast("Error deleting user", "error");
  }
}

async function loadRequests() {
  try {
    const res = await authenticatedFetch(`${scriptURL}?action=getRequests`);
    const requests = await res.json();
    renderRequests(requests);
  } catch (e) {
    showToast("Failed to load request logs", "error");
  }
}

function renderRequests(requests) {
  const tbody = document.getElementById("requestsTableBody");
  tbody.innerHTML = "";

  requests.forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="text-align: left;">${r.id}</td>
      <td>${new Date(r.time).toLocaleString()}</td>
    `;
    tbody.appendChild(tr);
  });
}

// Image Compression
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();

    reader.onload = e => {
      img.src = e.target.result;
    };

    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      const MAX_WIDTH = 1024;
      let width = img.width;
      let height = img.height;

      if (width > MAX_WIDTH) {
        height = height * (MAX_WIDTH / width);
        width = MAX_WIDTH;
      }

      canvas.width = width;
      canvas.height = height;

      ctx.drawImage(img, 0, 0, width, height);

      const compressedBase64 = canvas.toDataURL("image/jpeg", 0.7);
      resolve(compressedBase64);
    };

    img.onerror = reject;
    reader.onerror = reject;

    reader.readAsDataURL(file);
  });
}

// Image preview - FIXED VERSION with formType parameter
async function previewImage(event, formType) {
  const file = event.target.files[0];
  if (!file) return;

  // Get the correct form section based on formType
  const sectionId = formType === 'hazardous' ? 'hazardous-form-section' : 'solid-form-section';
  const uploadDiv = document.querySelector(`#${sectionId} .photo-upload`);
  const placeholder = uploadDiv.querySelector('.placeholder');

  let img = uploadDiv.querySelector("img");
  if (!img) {
    img = document.createElement("img");
    img.className = "photo-preview";
    uploadDiv.appendChild(img);
  }

  const imageBitmap = await createImageBitmap(file);

  const canvas = document.createElement("canvas");

  // 🔽 Resize for sanity (optional but safe)
  const MAX_WIDTH = 1280;
  let width = imageBitmap.width;
  let height = imageBitmap.height;

  if (width > MAX_WIDTH) {
    height = height * (MAX_WIDTH / width);
    width = MAX_WIDTH;
  }

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(imageBitmap, 0, 0, width, height);

  // 📌 Build watermark text
  const email = localStorage.getItem("userEmail") || "unknown";
  const pkg = selectedPackage || "N/A";

  let text = `HDJV ENVI UNIT\n`;
  text += `${new Date().toLocaleString()}\n`;

  try {
    const pos = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 5000 })
    );
    const lat = pos.coords.latitude.toFixed(6);
    const lng = pos.coords.longitude.toFixed(6);
    text += `Lat: ${lat} Lng: ${lng}\n`;
  } catch (e) {
    text += `Lat: N/A Lng: N/A\n`;
  }

  text += `User: ${email}\nPkg: ${pkg}`;

    // 🖤 Background bar with IMPROVED sizing
  const lines = text.split("\n");

  // IMPROVED Dynamic sizing
  const baseFontSize = Math.max(40, Math.floor(canvas.width / 28));
  const baseLineHeight = baseFontSize * 1.5;
  const basePadding = baseFontSize * 1.0;
  const calculatedBoxHeight = lines.length * baseLineHeight + basePadding * 2;
  
  // Ensure watermark doesn't exceed 20% of image height
  const maxBoxHeight = canvas.height * 0.20;
  const needsScaling = calculatedBoxHeight > maxBoxHeight;
  
  const finalBoxHeight = needsScaling ? maxBoxHeight : calculatedBoxHeight;
  const scale = needsScaling ? (maxBoxHeight / calculatedBoxHeight) : 1;
  
  const fontSize = baseFontSize * scale;
  const lineHeight = baseLineHeight * scale;
  const padding = basePadding * scale;
  
  // Draw semi-transparent black background
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  ctx.fillRect(0, canvas.height - finalBoxHeight, canvas.width, finalBoxHeight);
  
  // ✍️ Draw white text with dynamic sizing
  ctx.fillStyle = "white";
  ctx.font = `bold ${fontSize}px Arial`;
  ctx.textBaseline = "top";
  
  const startY = canvas.height - finalBoxHeight + padding;
  
  lines.forEach((line, i) => {
    const y = startY + (i * lineHeight);
    ctx.fillText(line, padding, y);
  });

  const finalImage = canvas.toDataURL("image/jpeg", 0.85);

  compressedImageBase64 = finalImage;
  img.src = finalImage;
  img.style.display = 'block';

  uploadDiv.classList.add("has-image");
  if (placeholder) placeholder.style.display = "none";
}

// Form validation
function validateForm() {
  const date = document.getElementById("date").value;
  const volume = document.getElementById("volume").value;
  const waste = document.getElementById("waste").value;

  if (!date) return false;
  if (!volume) return false;
  if (!waste) return false;
  if (!compressedImageBase64) return false;

  return true;
}


// add entry
async function addEntry(type) {
  if (type === 'hazardous') {
    await addHazardousEntry();
  } else if (type === 'solid') {
    await addSolidEntry();
  }
}

async function addHazardousEntry() {
  // Clear previous errors
  document.querySelectorAll('#hazardous-form-section .form-group').forEach(g => g.classList.remove('error'));

  const date = document.getElementById('hazardous-date').value;
  const volume = document.getElementById('hazardous-volume').value;
  const waste = document.getElementById('hazardous-waste').value;
  const photo = document.getElementById('hazardous-photo').files[0];

  let hasError = false;

  if (!date) {
    document.getElementById('hazardous-date-group').classList.add('error');
    hasError = true;
  }
  if (!volume) {
    document.getElementById('hazardous-volume-group').classList.add('error');
    hasError = true;
  }
  if (!waste) {
    document.getElementById('hazardous-waste-group').classList.add('error');
    hasError = true;
  }
  if (!photo) {
    document.getElementById('hazardous-photo-group').classList.add('error');
    hasError = true;
  }

  if (hasError) {
    showToast('Please fill in all required fields', 'error');
    return;
  }

  // ═══ ENHANCED DUPLICATE PREVENTION ═══
  
  // Create submission fingerprint FIRST (before any async operations)
  const submissionFingerprint = `${selectedPackage}-hazardous-${date}-${volume}-${waste}`;
  
  // FIRST CHECK: Was this already successfully submitted? (Check localStorage)
  const completionCheck = isSubmissionCompleted(submissionFingerprint);
  if (completionCheck.completed) {
    showToast(`Entry was already submitted ${completionCheck.hoursSince}h ago - please change the data to submit again`, 'error');
    return;
  }
  
  // Clean up expired fingerprints
  const now = Date.now();
  for (const [fp, timestamp] of submissionFingerprints.entries()) {
    if (now - timestamp > FINGERPRINT_LOCK_DURATION) {
      submissionFingerprints.delete(fp);
      console.log('🧹 Cleaned up expired fingerprint:', fp);
    }
  }
  
  // SECOND CHECK: Is this currently being submitted?
  if (submissionFingerprints.has(submissionFingerprint)) {
    const lockedAt = submissionFingerprints.get(submissionFingerprint);
    const secondsAgo = Math.floor((now - lockedAt) / 1000);
    console.log('🚫 DUPLICATE BLOCKED:', submissionFingerprint, `(locked ${secondsAgo}s ago)`);
    showToast(`Entry is currently being submitted - please wait`, 'error');
    return;
  }
  
  // LOCK THIS FINGERPRINT IMMEDIATELY - before watermarking or uploading
  submissionFingerprints.set(submissionFingerprint, now);
  console.log('🔒 LOCKED fingerprint:', submissionFingerprint);

  // Disable submit button
  const submitBtn = document.getElementById('hazardous-submitBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting...';

  // Generate DETERMINISTIC request ID (same submission = same ID)
  const requestId = generateRequestId(submissionFingerprint);
  activeSubmissions.add(requestId);
  console.log('📝 Using requestId:', requestId);

  // Show uploading toast with spinner
  showToast('Uploading...', 'info', { persistent: true, spinner: true });

  try {
    // Get email from localStorage
    const userEmail = localStorage.getItem("userEmail") || "Unknown";
    
    // Stamp image with watermark
    const watermarkedImage = await stampImageWithWatermark(photo, userEmail, selectedPackage);
    
    const payload = {
      requestId: requestId, // Now deterministic!
      token: localStorage.getItem("userToken"),
      package: selectedPackage,
      wasteType: 'hazardous',
      date: date,
      volume: volume,
      waste: waste,
      imageByte: watermarkedImage.split(',')[1],
      imageName: `${selectedPackage}_Hazardous_${Date.now()}.jpg`
    };

    // Add timeout to prevent hanging requests
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    const res = await authenticatedFetch(scriptURL, {
      method: 'POST',
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const data = await res.json();

    // Dismiss the uploading toast
    if (activeToast) {
      dismissToast(activeToast);
    }

    if (data.success) {
      console.log('✅ Upload SUCCESS for fingerprint:', submissionFingerprint);
      
      // CRITICAL: Mark as completed in localStorage
      markSubmissionAsCompleted(submissionFingerprint);
      
      // Keep fingerprint locked for full duration
      showToast('Entry submitted successfully!', 'success');
      
      // Clear form
      document.getElementById('hazardous-date').value = '';
      document.getElementById('hazardous-volume').value = '';
      document.getElementById('hazardous-waste').value = '';
      document.getElementById('hazardous-photo').value = '';
      
      // Reset photo preview properly
      const uploadDiv = document.querySelector('#hazardous-form-section .photo-upload');
      const img = uploadDiv.querySelector('.photo-preview');
      const placeholder = uploadDiv.querySelector('.placeholder');
      
      if (img) {
        img.remove();
      }
      
      if (placeholder) {
        placeholder.style.display = 'flex';
      }
      
      uploadDiv.classList.remove('has-image');
      
      // Reset date to today for next entry
      document.getElementById('hazardous-date').valueAsDate = new Date();
      
    } else if (data.error === 'Duplicate request') {
      // Server says it's a duplicate - this means it WAS already saved
      console.log('⚠️ Server reported duplicate - marking as completed');
      markSubmissionAsCompleted(submissionFingerprint);
      showToast('Entry was already submitted successfully', 'info');
      
      // Clear form since it was actually saved
      document.getElementById('hazardous-date').value = '';
      document.getElementById('hazardous-volume').value = '';
      document.getElementById('hazardous-waste').value = '';
      document.getElementById('hazardous-photo').value = '';
      
      const uploadDiv = document.querySelector('#hazardous-form-section .photo-upload');
      const img = uploadDiv.querySelector('.photo-preview');
      const placeholder = uploadDiv.querySelector('.placeholder');
      if (img) img.remove();
      if (placeholder) placeholder.style.display = 'flex';
      uploadDiv.classList.remove('has-image');
      
      document.getElementById('hazardous-date').valueAsDate = new Date();
      
    } else {
      console.log('❌ Upload FAILED for fingerprint:', submissionFingerprint, data.error);
      // On other failures, unlock after 30 seconds (longer than before)
      setTimeout(() => {
        submissionFingerprints.delete(submissionFingerprint);
        console.log('🔓 Unlocked failed fingerprint:', submissionFingerprint);
      }, 30000); // 30 seconds instead of 10
      
      showToast(data.error || 'Submission failed', 'error');
    }
  } catch (error) {
    console.error('💥 Error during upload:', error);
    
    // Dismiss the uploading toast
    if (activeToast) {
      dismissToast(activeToast);
    }
    
    // On network error, keep lock for LONGER (60 seconds) 
    // This prevents rapid retry attempts that create duplicates
    setTimeout(() => {
      submissionFingerprints.delete(submissionFingerprint);
      console.log('🔓 Unlocked errored fingerprint after network error:', submissionFingerprint);
    }, 60000); // 60 seconds for network errors
    
    // Provide more specific error messages
    if (error.name === 'AbortError') {
      showToast('Upload timeout - entry may have been saved - check history before retrying', 'error');
    } else if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      showToast('Network error - entry may have been saved - check history before retrying', 'error');
    } else {
      showToast('Error submitting entry - check history before retrying', 'error');
    }
  } finally {
    // Remove from active submissions
    activeSubmissions.delete(requestId);
    
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Entry';
  }
}

// NEW: Solid waste entry
async function addSolidEntry() {
  // Clear previous errors
  document.querySelectorAll('#solid-form-section .form-group').forEach(g => g.classList.remove('error'));

  const date = document.getElementById('solid-date').value;
  const locationNum = document.getElementById('solid-location').value;
  const waste = document.getElementById('solid-waste').value;
  const photo = document.getElementById('solid-photo').files[0];

  let hasError = false;

  if (!date) {
    document.getElementById('solid-date-group').classList.add('error');
    hasError = true;
  }
  if (!locationNum || locationNum < 462 || locationNum > 1260) {
    document.getElementById('solid-location-group').classList.add('error');
    hasError = true;
  }
  if (!waste) {
    document.getElementById('solid-waste-group').classList.add('error');
    hasError = true;
  }
  if (!photo) {
    document.getElementById('solid-photo-group').classList.add('error');
    hasError = true;
  }

  if (hasError) {
    showToast('Please fill in all required fields', 'error');
    return;
  }

  // ═══ ENHANCED DUPLICATE PREVENTION ═══
  
  const location = `P-${locationNum}`;
  
  // Create submission fingerprint FIRST (before any async operations)
  const submissionFingerprint = `${selectedPackage}-solid-${date}-${location}-${waste}`;
  
  // FIRST CHECK: Was this already successfully submitted? (Check localStorage)
  const completionCheck = isSubmissionCompleted(submissionFingerprint);
  if (completionCheck.completed) {
    showToast(`Entry was already submitted ${completionCheck.hoursSince}h ago - please change the data to submit again`, 'error');
    return;
  }
  
  // Clean up expired fingerprints
  const now = Date.now();
  for (const [fp, timestamp] of submissionFingerprints.entries()) {
    if (now - timestamp > FINGERPRINT_LOCK_DURATION) {
      submissionFingerprints.delete(fp);
      console.log('🧹 Cleaned up expired fingerprint:', fp);
    }
  }
  
  // SECOND CHECK: Is this currently being submitted?
  if (submissionFingerprints.has(submissionFingerprint)) {
    const lockedAt = submissionFingerprints.get(submissionFingerprint);
    const secondsAgo = Math.floor((now - lockedAt) / 1000);
    console.log('🚫 DUPLICATE BLOCKED:', submissionFingerprint, `(locked ${secondsAgo}s ago)`);
    showToast(`Entry is currently being submitted - please wait`, 'error');
    return;
  }
  
  // LOCK THIS FINGERPRINT IMMEDIATELY - before watermarking or uploading
  submissionFingerprints.set(submissionFingerprint, now);
  console.log('🔒 LOCKED fingerprint:', submissionFingerprint);

  // Disable submit button
  const submitBtn = document.getElementById('solid-submitBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting...';

  // Generate DETERMINISTIC request ID (same submission = same ID)
  const requestId = generateRequestId(submissionFingerprint);
  activeSubmissions.add(requestId);
  console.log('📝 Using requestId:', requestId);

  // Show uploading toast with spinner
  showToast('Uploading...', 'info', { persistent: true, spinner: true });

  try {
    // Get email from localStorage
    const userEmail = localStorage.getItem("userEmail") || "Unknown";
    
    // Stamp image with watermark
    const watermarkedImage = await stampImageWithWatermark(photo, userEmail, selectedPackage);
    
    const payload = {
      requestId: requestId, // Now deterministic!
      token: localStorage.getItem("userToken"),
      package: selectedPackage,
      wasteType: 'solid',
      date: date,
      location: location,
      waste: waste,
      imageByte: watermarkedImage.split(',')[1],
      imageName: `${selectedPackage}_Solid_${Date.now()}.jpg`
    };

    // Add timeout to prevent hanging requests
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    const res = await authenticatedFetch(scriptURL, {
      method: 'POST',
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    const data = await res.json();

    // Dismiss the uploading toast
    if (activeToast) {
      dismissToast(activeToast);
    }

    if (data.success) {
      console.log('✅ Upload SUCCESS for fingerprint:', submissionFingerprint);
      
      // CRITICAL: Mark as completed in localStorage
      markSubmissionAsCompleted(submissionFingerprint);
      
      // Keep fingerprint locked for full duration
      showToast('Entry submitted successfully!', 'success');
      
      // Clear form
      document.getElementById('solid-date').value = '';
      document.getElementById('solid-location').value = '';
      document.getElementById('solid-waste').value = '';
      document.getElementById('solid-photo').value = '';
      
      // Reset photo preview properly
      const uploadDiv = document.querySelector('#solid-form-section .photo-upload');
      const img = uploadDiv.querySelector('.photo-preview');
      const placeholder = uploadDiv.querySelector('.placeholder');
      
      if (img) {
        img.remove();
      }
      
      if (placeholder) {
        placeholder.style.display = 'flex';
      }
      
      uploadDiv.classList.remove('has-image');
      
      // Reset date to today for next entry
      document.getElementById('solid-date').valueAsDate = new Date();
      
    } else if (data.error === 'Duplicate request') {
      // Server says it's a duplicate - this means it WAS already saved
      console.log('⚠️ Server reported duplicate - marking as completed');
      markSubmissionAsCompleted(submissionFingerprint);
      showToast('Entry was already submitted successfully', 'info');
      
      // Clear form since it was actually saved
      document.getElementById('solid-date').value = '';
      document.getElementById('solid-location').value = '';
      document.getElementById('solid-waste').value = '';
      document.getElementById('solid-photo').value = '';
      
      const uploadDiv = document.querySelector('#solid-form-section .photo-upload');
      const img = uploadDiv.querySelector('.photo-preview');
      const placeholder = uploadDiv.querySelector('.placeholder');
      if (img) img.remove();
      if (placeholder) placeholder.style.display = 'flex';
      uploadDiv.classList.remove('has-image');
      
      document.getElementById('solid-date').valueAsDate = new Date();
      
    } else {
      console.log('❌ Upload FAILED for fingerprint:', submissionFingerprint, data.error);
      // On other failures, unlock after 30 seconds (longer than before)
      setTimeout(() => {
        submissionFingerprints.delete(submissionFingerprint);
        console.log('🔓 Unlocked failed fingerprint:', submissionFingerprint);
      }, 30000); // 30 seconds instead of 10
      
      showToast(data.error || 'Submission failed', 'error');
    }
  } catch (error) {
    console.error('💥 Error during upload:', error);
    
    // Dismiss the uploading toast
    if (activeToast) {
      dismissToast(activeToast);
    }
    
    // On network error, keep lock for LONGER (60 seconds)
    // This prevents rapid retry attempts that create duplicates
    setTimeout(() => {
      submissionFingerprints.delete(submissionFingerprint);
      console.log('🔓 Unlocked errored fingerprint after network error:', submissionFingerprint);
    }, 60000); // 60 seconds for network errors
    
    // Provide more specific error messages
    if (error.name === 'AbortError') {
      showToast('Upload timeout - entry may have been saved - check history before retrying', 'error');
    } else if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      showToast('Network error - entry may have been saved - check history before retrying', 'error');
    } else {
      showToast('Error submitting entry - check history before retrying', 'error');
    }
  } finally {
    // Remove from active submissions
    activeSubmissions.delete(requestId);
    
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Entry';
  }
}

  
// Load history
async function loadHistory(type) {
  const prefix = type;
  
  const from = document.getElementById(`${prefix}-fromDate`).value;
  const to = document.getElementById(`${prefix}-toDate`).value;

  if (!from || !to) {
    showToast('Please select a date range', 'error');
    return;
  }

  if (!selectedPackage) {
    showToast('No package selected', 'error');
    return;
  }

  const fromDate = new Date(from);
  const toDate = new Date(to);
  const diffDays = (toDate - fromDate) / (1000 * 60 * 60 * 24);

  if (diffDays > 31) {
    showToast('Date range must be 31 days or less', 'error');
    return;
  }

  document.getElementById(`${prefix}-loading`).style.display = 'block';
  document.getElementById(`${prefix}-table-container`).style.display = 'none';
  document.getElementById(`${prefix}-empty-state`).style.display = 'none';

  const url = `${scriptURL}?package=${selectedPackage}&wasteType=${type}&from=${from}&to=${to}`;

  try {
    const res = await authenticatedFetch(url);
    const rows = await res.json();
    
    // Store for export
    if (type === 'hazardous') {
      window.loadedHazardousRows = rows;
    } else {
      window.loadedSolidRows = rows;
    }

    document.getElementById(`${prefix}-loading`).style.display = 'none';

    if (rows.error) {
      showToast(rows.error, 'error');
      document.getElementById(`${prefix}-empty-state`).style.display = 'block';
      return;
    }

    const tbody = document.getElementById(`${prefix}-table-body`);
    tbody.innerHTML = '';

    if (rows.length <= 1) {
      document.getElementById(`${prefix}-empty-state`).style.display = 'block';
      return;
    }

    document.getElementById(`${prefix}-table-container`).style.display = 'block';
    document.getElementById(`${prefix}-exportBtn`).disabled = false;

    rows.slice(1).forEach(r => {
      const date = new Date(r[0]).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric"
      });

      let imageUrl = "";
      const photoCol = 5;
      
      if (r[photoCol]) {
        const match = r[photoCol].match(/\/d\/([^/]+)/);
        if (match) {
          imageUrl = `https://drive.google.com/uc?export=view&id=${match[1]}`;
        } else {
          imageUrl = r[photoCol];
        }
      }
      
      const photoLink = imageUrl
        ? `<a class="photo-link" onclick="openImageModal('${imageUrl}')">View</a>`
        : '—';

      const tr = document.createElement("tr");
      
      if (type === 'hazardous') {
        tr.innerHTML = `
          <td>${date}</td>
          <td>${r[1]}</td>
          <td>${r[2]}</td>
          <td>${r[4]}</td>
          <td>${photoLink}</td>
        `;
      } else {
        tr.innerHTML = `
          <td>${date}</td>
          <td>${r[1]}</td>
          <td>${r[2]}</td>
          <td>${r[4]}</td>
          <td>${photoLink}</td>
        `;
      }
      
      tbody.appendChild(tr);
    });
  } catch (err) {
    document.getElementById(`${prefix}-loading`).style.display = 'none';
    showToast('Error loading data', 'error');
    console.error(err);
  }
}

// Export to XLSX
async function exportExcel(type) {
  const prefix = type;
  const btn = document.getElementById(`${prefix}-exportBtn`);
  const rows = type === 'hazardous' ? window.loadedHazardousRows : window.loadedSolidRows;

  if (!rows || rows.length <= 1) {
    showToast("No data to export", "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Exporting...";

  try {
    const exportRows = JSON.parse(JSON.stringify(rows));
    
    if (type === 'hazardous') {
      exportRows[0] = ["Date", "Volume (kg)", "Waste Name", "Package", "User", "Photo Link", "System Timestamp"];
    } else {
      exportRows[0] = ["Date", "Location (Pier)", "Waste Name", "Package", "User", "Photo Link", "System Timestamp"];
    }

    for (let i = 1; i < exportRows.length; i++) {
      exportRows[i][0] = new Date(exportRows[i][0]).toLocaleDateString("en-US");
      if (exportRows[i][6]) {
        exportRows[i][6] = new Date(exportRows[i][6]).toLocaleString("en-US");
      }
    }

    const worksheet = XLSX.utils.aoa_to_sheet(exportRows);
    
    if (type === 'hazardous') {
      worksheet["!cols"] = [
        { wch: 15 }, { wch: 15 }, { wch: 40 }, { wch: 15 }, 
        { wch: 30 }, { wch: 80 }, { wch: 22 }
      ];
    } else {
      worksheet["!cols"] = [
        { wch: 15 }, { wch: 15 }, { wch: 30 }, { wch: 15 }, 
        { wch: 30 }, { wch: 80 }, { wch: 22 }
      ];
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Records");

    const filename = `${type}_waste_log_${selectedPackage}_${new Date()
      .toISOString()
      .split("T")[0]}.xlsx`;

    XLSX.writeFile(workbook, filename);
    showToast("Excel exported successfully!", "success");

  } catch (err) {
    console.error(err);
    showToast("Export failed", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Export to Excel (XLSX)";
  }
}

// Parse JWT token
function parseJwt(token) {
  var base64Url = token.split('.')[1];
  var base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  var jsonPayload = decodeURIComponent(window.atob(base64).split('').map(function(c) {
    return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
  }).join(''));
  return JSON.parse(jsonPayload);
}

// Display user info in header
function displayUserInfo(name, role) {
  const userInfo = document.getElementById('user-info');
  const userName = document.getElementById('user-name');
  const roleBadge = document.getElementById('user-role-badge');
  const modeToggle = document.getElementById('mode-toggle');
  
  if (userInfo && userName && roleBadge) {
    userName.textContent = name;
    
    // Set role badge text and styling
    if (role === 'super_admin') {
      roleBadge.textContent = 'SUPER ADMIN';
      roleBadge.className = 'role-badge super_admin';
    } else if (role === 'admin') {
      roleBadge.textContent = 'ADMIN';
      roleBadge.className = 'role-badge admin';
    } else {
      roleBadge.textContent = 'USER';
      roleBadge.className = 'role-badge';
    }
    
    // Show mode toggle for admins and super admins
    if (role === 'admin' || role === 'super_admin') {
      // Show mode toggle for admins
      if (modeToggle) {
        modeToggle.style.display = 'flex';
        // Initialize to user mode (false = user mode)
        // This only runs once at login, won't affect navigation
        updateModeLabels(false);
      }
    }
    
    userInfo.style.display = 'flex';
  }
}

// Toggle between admin and user modes
function toggleAdminMode() {
  const toggle = document.getElementById('admin-mode-toggle');
  const isAdminMode = toggle.checked;

  if (isAdminMode) {
    showSection('admin-dashboard');
    showToast('Switched to Admin mode', 'info');
  } else {
    showSection('package-section');
    showToast('Switched to User mode', 'info');
  }
}



// Update mode label highlighting
function updateModeLabels(isAdminMode) {
  const userLabel = document.getElementById('mode-label-user');
  const adminLabel = document.getElementById('mode-label-admin');
  
  if (userLabel && adminLabel) {
    if (isAdminMode) {
      userLabel.classList.remove('active');
      adminLabel.classList.add('active');
    } else {
      userLabel.classList.add('active');
      adminLabel.classList.remove('active');
    }
  }
}

// Update toggle state based on current section
function updateToggleState(sectionId) {
  const toggle = document.getElementById('admin-mode-toggle');
  if (!toggle) return;

  const adminSections = [
    'admin-dashboard',
    'user-management-section',
    'request-logs-section'
  ];

  const isAdminSection = adminSections.includes(sectionId);

  toggle.checked = isAdminSection;
  updateModeLabels(isAdminSection);
}


// Logout function
// Improved Logout function
async function logout() {
  if (!confirm('Are you sure you want to sign out?')) {
    return;
  }
  
  const token = localStorage.getItem('userToken');
  
  // Show loading
  showToast('Signing out...', 'info', { persistent: true });
  
  try {
    // Call server logout to invalidate token
    if (token) {
      try {
        await authenticatedFetch(`${scriptURL}?action=logout`);
      } catch (e) {
        // Ignore errors during logout
      }
    }
  } catch (err) {
    console.error('Logout error:', err);
    // Continue with local logout even if server call fails
  }
  
  // Clear ALL localStorage data
  localStorage.removeItem('userToken');
  localStorage.removeItem('tokenExpiry');
  localStorage.removeItem('userRole');
  localStorage.removeItem('userEmail');
  localStorage.removeItem('completedSubmissions');
  
  // Reset UI
  document.body.classList.remove('is-admin');
  const userInfo = document.getElementById('user-info');
  if (userInfo) userInfo.style.display = 'none';
  
  // Stop session monitoring
  if (sessionCheckTimer) {
    clearInterval(sessionCheckTimer);
    sessionCheckTimer = null;
  }
  
  // Stop token refresh timer
  stopTokenRefreshTimer();
  
  // Sign out from Google
  if (window.google && google.accounts && google.accounts.id) {
    google.accounts.id.disableAutoSelect();
  }
  
  // Show login screen
  showSection('login-section');
  
  // Reload page after short delay to fully reset Google Sign-In
  setTimeout(() => {
    location.reload();
  }, 500);
}


// Google login handler - UPDATED
async function handleCredentialResponse(response) {
  setLoginLoading(true);

  const responsePayload = parseJwt(response.credential);
  const email = responsePayload.email.toLowerCase();
  const name = responsePayload.name;

  try {
    const checkURL = `${scriptURL}?email=${encodeURIComponent(email)}`;
    const res = await fetch(checkURL);
    const data = await res.json();

    setLoginLoading(false);

    if (data.status === "Approved") {
      // Store all session data
      localStorage.setItem("userToken", data.token);
      localStorage.setItem("userRole", data.role || "user");
      localStorage.setItem("userEmail", email);
      localStorage.setItem("tokenExpiry", data.tokenExpiry);
      
      console.log("✅ Login successful");
      console.log("User role:", data.role);
      console.log("Token expiry:", new Date(data.tokenExpiry));
      
      // Calculate days until expiry
      const daysUntilExpiry = Math.floor((data.tokenExpiry - Date.now()) / (1000 * 60 * 60 * 24));

      displayUserInfo(name, data.role || "user");
      showToast(`Welcome, ${name}! Session valid for ${daysUntilExpiry} days`, "success");
      showSection("package-section");
      
      // Start session monitoring
      startSessionMonitoring();
      
      if (data.role === "admin" || data.role === "super_admin") {
        console.log("🔑 Enabling admin UI for role:", data.role);
        enableAdminUI();
      } else {
        console.log("👤 User role - no admin access");
      }
    } else if (data.status === "Rejected") {
      showToast("Access denied by admin", "error");
    } else {
      showToast("Awaiting admin approval", "info");
    }

  } catch (err) {
    console.error(err);
    setLoginLoading(false);
    showToast("Connection error", "error");
  }
}


// Initialize
// Initialize - UPDATED with auto-login
window.onload = async function() {
  if (DEV_MODE) {
    console.warn('⚠️ DEV MODE ENABLED');
    localStorage.setItem("userToken", "DEV_TOKEN");
    document.querySelectorAll('.section')
      .forEach(s => s.classList.remove('active'));
    document.getElementById('package-section').classList.add('active');
    showToast('Dev mode active - Auth bypassed', 'info');
    return;
  }

  // ═══ AUTO-LOGIN: Check for existing valid session ═══
  const existingToken = localStorage.getItem('userToken');
  const userEmail = localStorage.getItem('userEmail');
  const userRole = localStorage.getItem('userRole');
  
  if (existingToken && userEmail) {
    console.log('Found existing session, validating...');
    
    // Validate the session
    const isValid = await validateSession();
    
    if (isValid) {
      // Session is valid - restore user interface
      console.log('Session valid - auto-logging in');
      
      const userName = userEmail.split('@')[0];
      displayUserInfo(userName, userRole || 'user');
      showSection('package-section');
      
      if (userRole === 'admin' || userRole === 'super_admin') {
        enableAdminUI();
      }
      
      // Start session monitoring
      startSessionMonitoring();
      
      // Show welcome back message
      const minutesLeft = getTimeUntilExpiry();
      const hoursLeft = Math.floor(minutesLeft / 60);
      showToast(`Welcome back! Session expires in ${hoursLeft}h`, 'success');
      
      // Don't show Google Sign-In button
      return;
    } else {
      console.log('Session invalid or expired');
      // Will fall through to show Google Sign-In
    }
  }

  // ═══ NORMAL MODE: Show Google Sign-In ═══
  if (window.google && google.accounts && google.accounts.id) {
    google.accounts.id.initialize({
      client_id: "648943267004-cgsr4bhegtmma2jmlsekjtt494j8cl7f.apps.googleusercontent.com",
      callback: handleCredentialResponse,
      auto_select: false,
      cancel_on_tap_outside: true
    });

    google.accounts.id.renderButton(
      document.getElementById("buttonDiv"),
      { theme: "outline", size: "large", width: "250" }
    );
  } else {
    console.error("Google Identity not loaded");
    showToast('Login service unavailable', 'error');
  }
};

// Modal functions
function openImageModal(url) {
  const modal = document.getElementById("imageModal");
  const img = document.getElementById("modalImage");

  const match = url.match(/[-\w]{25,}/);
  if (!match) {
    showToast("Invalid image link", "error");
    return;
  }

  const fileId = match[0];
  const directUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=w1200`;

  img.src = directUrl;
  modal.style.display = "flex";
}

function closeImageModal() {
  const modal = document.getElementById("imageModal");
  const img = document.getElementById("modalImage");

  img.src = "";
  modal.style.display = "none";
}

function enableAdminUI() {
  document.body.classList.add("is-admin");
  
  // Also show the mode toggle
  const modeToggle = document.getElementById('mode-toggle');
  if (modeToggle) {
    modeToggle.style.display = 'flex';
  }
  
  console.log("✅ Admin mode enabled - is-admin class added");
  console.log("Body classes:", document.body.className);
  console.log("Admin sections should now be visible");
}

  //additional js

  function selectWasteType(type) {
  selectedWasteType = type;
  if (type === 'hazardous') {
    showSection('hazardous-menu-section');
  } else if (type === 'solid') {
    showSection('solid-menu-section');
  }
}

// Back to waste type selection
function backToWasteType() {
  showSection('waste-type-section');
}

// Back to hazardous menu
function backToHazardousMenu() {
  showSection('hazardous-menu-section');
}

// Back to solid menu
function backToSolidMenu() {
  showSection('solid-menu-section');
}
