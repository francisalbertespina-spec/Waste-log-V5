# HDJV Waste Management System (WMS)

> A Progressive Web App for logging, tracking, and managing hazardous and solid waste across construction packages — built on Google Apps Script and Google Sheets.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [User Roles](#user-roles)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Security](#security)
- [Deployment](#deployment)

---

## Overview

The HDJV WMS allows field workers to log waste disposal activities per construction package (P4, P5, P6) for two waste categories: **Hazardous** and **Solid**. Admins manage user access, view analytics, and export reports — all backed by Google Sheets as the data store and Google Apps Script as the serverless backend.

---

## Features

| Feature | Description |
|---|---|
| 🔐 Token Auth | UUID-based session tokens with 7-day expiry stored in Google Sheets |
| 📦 Package Selection | Supports packages P4, P5, P6 with isolated data per package |
| ☣️ Hazardous Waste Logging | Date, volume (liters), waste name, photo upload |
| 🗑️ Solid Waste Logging | Date, dump location, waste name, photo upload |
| 🖼️ Photo Watermarking | Canvas-based image watermarking with user email and package |
| 📊 Analytics Dashboard | Trend charts, waste breakdown, contributor leaderboard |
| 📄 PDF Export | jsPDF-powered analytics reports with charts |
| 📥 Excel Export | XLSX export of history records |
| 👥 User Management | Approve/reject/delete users, assign roles |
| 🔔 Push Notifications | Service Worker–based admin alerts for pending user approvals |
| 🌙 Dark/Light Theme | User-selectable UI theme, persisted in localStorage |
| 📶 Rate Limiting | Per-user 100 requests/hour enforced server-side |
| 📋 Audit Logging | All API actions logged to an `Access_Log` sheet |

---

## Tech Stack

### Frontend
- **Vanilla JavaScript** — no framework
- **CSS3** — custom design with CSS variables for theming
- **Chart.js** — trend and breakdown charts
- **jsPDF** — PDF report generation
- **SheetJS (xlsx)** — Excel export
- **Canvas API** — photo watermarking
- **Service Worker** — push notifications & background sync

### Backend
- **Google Apps Script** — serverless REST API (`doGet` / `doPost`)
- **Google Sheets** — data persistence (Users, waste logs, access logs, rate limits)
- **Google Drive** — photo file storage per package folder
- **Gmail / MailApp** — email notifications for access approval/rejection

---

## Project Structure

```
/
├── index.html          # Main SPA shell — all sections rendered here
├── style.css           # All UI styles, themes, animations
├── script.js           # All client-side logic (~900+ lines)
├── sw.js               # Service Worker for push notifications
└── Code.gs             # Google Apps Script backend (deployed as Web App)
```

### Google Sheets Structure

| Sheet | Purpose |
|---|---|
| `Users` | Email, Status, Token, Last Login, Role, Token Expiry |
| `RateLimits` | Per-user request counters and window timestamps |
| `Requests` | Idempotency log (request IDs to prevent duplicate submissions) |
| `Access_Log` | Full audit trail of all API actions |

Per-package waste data is stored in **separate Google Sheets** (one per package per waste type), configured in `PACKAGE_MAP` and `SOLID_PACKAGE_MAP`.

---

## User Roles

| Role | Permissions |
|---|---|
| `user` | Log waste, view own history, export records |
| `admin` | All user permissions + approve/reject pending users, view analytics, view all users |
| `super_admin` | All admin permissions + change user roles, delete users, full user list access |

---

## Getting Started

### Prerequisites
- A Google Account
- Access to Google Sheets and Google Drive
- The web app hosted on GitHub Pages (or any static host)

### 1. Set Up Google Sheets

Create the following sheets:
- **Users Sheet** — columns: `Email`, `Status`, `Token`, `Last Login`, `Role`, `Token Expiry`
- **Per-package waste sheets** — for P4, P5, P6 (both hazardous and solid)

Copy each Sheet ID from the URL: `https://docs.google.com/spreadsheets/d/SHEET_ID/edit`

### 2. Set Up Google Drive Folders

Create a Google Drive folder per package (P4, P5, P6) for each waste type to store uploaded photos.

### 3. Configure the Backend Script

In `Code.gs`, update the configuration constants:

```javascript
const USER_SHEET_ID = "your-users-sheet-id";

const PACKAGE_MAP = {
  "P4": { sheetId: "...", folderId: "...", sheetName: "Sheet1" },
  "P5": { sheetId: "...", folderId: "...", sheetName: "Sheet1" },
  "P6": { sheetId: "...", folderId: "...", sheetName: "Sheet1" }
};

const SOLID_PACKAGE_MAP = {
  "P4": { sheetId: "...", folderId: "...", sheetName: "Sheet1" },
  // ...
};
```

### 4. Deploy the Google Apps Script

1. Open the script in Google Apps Script editor
2. Click **Deploy → New Deployment**
3. Type: **Web App**
4. Execute as: **Me**
5. Access: **Anyone**
6. Copy the deployment URL

### 5. Configure the Frontend

In `script.js`, set the Apps Script URL:

```javascript
const scriptURL = "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec";
```

### 6. Deploy the Frontend

Push `index.html`, `style.css`, `script.js`, and `sw.js` to GitHub Pages or any static host.

---

## API Reference

All requests go to the deployed Apps Script URL.

### Authentication

All protected endpoints require a `token` query parameter obtained at login.

### Endpoints (GET)

| Action | Parameters | Auth Required | Description |
|---|---|---|---|
| Login | `email` | ❌ | Checks user status; returns token if approved |
| `validateToken` | `token` | ✅ | Validates session token |
| `refreshToken` | `token` | ✅ | Extends token expiry by 7 days |
| `logout` | `token` | ✅ | Clears token from sheet |
| `getUsers` | `token` | ✅ Admin | Returns user list |
| `approveUser` | `token`, `email` | ✅ Admin | Sets user status to Approved |
| `rejectUser` | `token`, `email` | ✅ Admin | Sets user status to Rejected |
| `updateUserRole` | `token`, `email`, `role` | ✅ Super Admin | Updates user role |
| `deleteUser` | `token`, `email` | ✅ Super Admin | Deletes user row |
| `getRequests` | `token` | ✅ Admin | Returns request ID log |
| `getImageBase64` | `token`, `id` | ✅ | Returns Drive image as base64 |
| Fetch records | `token`, `package`, `wasteType`, `from`, `to` | ✅ | Returns waste log rows |

### Endpoints (POST)

| Action | Body Fields | Description |
|---|---|---|
| Log hazardous waste | `token`, `package`, `date`, `volume`, `waste`, `imageByte`, `requestId`, `wasteType: "hazardous"` | Appends a hazardous waste row |
| Log solid waste | `token`, `package`, `date`, `location`, `waste`, `imageByte`, `requestId`, `wasteType: "solid"` | Appends a solid waste row |

---

## Security

- **Token-based auth**: UUIDs stored in Google Sheets, validated on every request
- **Token expiry**: 7-day rolling window; expired tokens are cleared on validation
- **Rate limiting**: 100 requests/hour per user enforced server-side
- **Role-based access control**: Enforced on all admin endpoints
- **Idempotency**: `requestId` prevents duplicate waste log submissions
- **Audit log**: All actions, emails, and outcomes logged to `Access_Log` sheet
- **Email notifications**: Users notified on approval/rejection; super admins notified on new registrations

---

## Deployment

The app is a static SPA deployable to any host (GitHub Pages, Netlify, Vercel, etc.). The backend is a Google Apps Script Web App — no server infrastructure required.

**Live URL**: `https://francisalbertespina-spec.github.io/Waste-log-V5/`

---

## License

Internal use — HDJV Environmental Management.
