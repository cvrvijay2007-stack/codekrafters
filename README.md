# 🌱 Sage: AI Study Assistant

A calm, student-friendly study assistant. Enter a topic and get an explanation, concise notes, an MCQ quiz, or a personalised study plan at Beginner, Intermediate or Advanced level.

## Features
- Registration & login (bcrypt password hashes, JWT sessions)
- AI chat with multiple conversations, history stored in SQLite
- Explain / Notes / Quiz (tap-to-reveal answers) / Study plan modes
- Difficulty selection, driven by a structured system prompt
- Generated notes, quizzes and plans saved to a `saved` table (`GET /api/saved`)
- Upload a `.txt` / `.pdf` and ask questions about it
- Export replies as Markdown or print to PDF
- Loading and error states; responsive layout
- API key kept server-side in environment variables

## Run locally
```bash
npm install
cp .env.example .env     # Windows: copy .env.example .env
# edit .env: add ANTHROPIC_API_KEY and a long random JWT_SECRET
npm start                # http://localhost:3000
```

## Structure
```
server.js          Express API, auth, DB, LLM call, prompts
public/index.html  Frontend (single page)
.env.example       Required environment variables
render.yaml        One-click deploy config for Render
```

## API
| Method | Route | Purpose |
|---|---|---|
| POST | /api/register, /api/login | Auth |
| GET/POST | /api/conversations | List / create |
| DELETE | /api/conversations/:id | Delete |
| GET | /api/conversations/:id/messages | Chat history |
| POST | /api/conversations/:id/chat | `{message, mode, level}` |
| POST | /api/conversations/:id/upload | Upload txt/pdf |
| GET | /api/saved | Saved notes, quizzes, plans |

## Security notes
`.env` and the database are git-ignored. Never commit your API key. Before production, add rate limiting (`express-rate-limit`) and a persistent database (SQLite files reset on most free hosts).
