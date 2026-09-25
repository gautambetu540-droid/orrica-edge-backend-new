# 🚀 Orrica Edge — Backend API & ATS Engine

Production-grade RESTful API server for the **Orrica Edge** recruitment platform, built with **Node.js, TypeScript, Express, Prisma ORM, and PostgreSQL**.

---

## 📁 Architecture & Features

- **Authentication & RBAC:** JWT authentication with role-based access (`SUPER_ADMIN`, `ADMIN`, `RECRUITER`, `CLIENT`, `CANDIDATE`).
- **Jobs Engine:** Full CRUD, unique auto-generated Job IDs (`OE-2026-XXX`), SEO slugs, view incrementing, and filter queries.
- **ATS Candidate Pipeline:** Multi-stage applicant tracking (`APPLIED` ➔ `SCREENING` ➔ `ASSESSMENT` ➔ `INTERVIEW` ➔ `SELECTED` ➔ `OFFERED` ➔ `JOINED` ➔ `REJECTED`).
- **Resume Upload & ATS Match:** Multer PDF/DOCX storage with automated keyword match scoring (0–100%).
- **Career Resources (CMS):** Dynamic blog management with categories, reading time, view tracking, and rich markdown storage.
- **Lead Capture:** Employer "Hire Talent" inquiries, Recruiter partnership applications, and contact submissions.

---

## 🛠️ Tech Stack

- **Runtime:** Node.js 20+
- **Language:** TypeScript 5.7+
- **Framework:** Express.js 4.21+
- **Database & ORM:** PostgreSQL 16+ with Prisma ORM 5.22+
- **Validation:** Zod 3.23+
- **Security:** Helmet, CORS, bcryptjs, JWT

---

## ⚡ Quick Start (Local Setup)

### 1. Install Dependencies
```bash
cd backend
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Update `DATABASE_URL` with your PostgreSQL database credentials:
```env
DATABASE_URL="postgresql://postgres:yourpassword@localhost:5432/orrica_edge_db?schema=public"
```

### 3. Setup Database Schema & Seed Data
```bash
# Push schema to database
npx prisma db push

# (Optional) Seed initial Admin, Recruiter, Client, and Jobs data
npm run prisma:seed
```

### 4. Start Development Server
```bash
npm run dev
```
Server will be available at: **`http://localhost:5000`**

---

## 🔑 Default Seed Credentials

After running `npm run prisma:seed`:

| Role | Email | Password |
| :--- | :--- | :--- |
| **Super Admin** | `admin@orricaedge.com` | `Admin@12345` |
| **Recruiter** | `recruiter@orricaedge.com` | `Recruiter@12345` |

---

## 📡 API Endpoints Overview

### 🔐 1. Authentication (`/api/v1/auth`)
| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/auth/register` | Public | Register new user account |
| `POST` | `/api/v1/auth/login` | Public | Login and receive JWT access token |
| `GET` | `/api/v1/auth/me` | Bearer Token | Fetch current authenticated user |

---

### 💼 2. Jobs (`/api/v1/jobs`)
| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/jobs` | Public | Search & filter published jobs (pagination, location, workMode) |
| `GET` | `/api/v1/jobs/:slug` | Public | Get single job by slug or ID + auto-increments view counter |
| `POST` | `/api/v1/jobs` | Admin / Recruiter | Create new job (auto-generates code `OE-2026-001`) |
| `PUT` | `/api/v1/jobs/:id` | Admin / Recruiter | Update existing job |
| `DELETE` | `/api/v1/jobs/:id` | Admin | Delete / Archive job |

---

### 📄 3. Applications & ATS Pipeline (`/api/v1/applications`)
| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/applications/apply` | Public (`multipart/form-data`) | Quick apply with resume PDF + auto ATS score |
| `GET` | `/api/v1/applications` | Admin / Recruiter | Filter applications by `jobId`, `stage`, candidate search |
| `PATCH`| `/api/v1/applications/:id/stage` | Admin / Recruiter | Move candidate stage (e.g. `SCREENING` ➔ `INTERVIEW`) |

---

### 📰 4. Career Resources / Blogs (`/api/v1/blogs`)
| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/blogs` | Public | List articles by category, featured flag, and pagination |
| `GET` | `/api/v1/blogs/:slug` | Public | Get article details + related posts + auto view counter |
| `POST` | `/api/v1/blogs` | Admin | Publish new career article |
| `PUT` | `/api/v1/blogs/:id` | Admin | Update career article |
| `DELETE` | `/api/v1/blogs/:id` | Admin | Delete article |

---

### 📥 5. Inquiries & Leads (`/api/v1/inquiries`)
| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/inquiries/hire-talent` | Public | Submit "Hire Talent" enterprise request |
| `POST` | `/api/v1/inquiries/recruiter-partner` | Public | Submit "For Recruiters" partnership form |
| `POST` | `/api/v1/inquiries/contact` | Public | Submit general contact message |
| `GET` | `/api/v1/inquiries` | Admin | View and manage incoming inquiries |

---

## 🐳 Docker Deployment

To launch the backend API and PostgreSQL database with a single command:
```bash
docker compose up -d --build
```
This runs PostgreSQL on port `5432` and the Orrica Edge API server on port `5000`.
