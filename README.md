# Local AI Coding Agent

A fully capable AI coding agent that runs on your machine. It can read and write files, run shell commands, build full applications, debug code, search codebases, and more — everything Replit Agent does, but running entirely locally.

---

## What it can do

- **Read & write files** — create, edit, or delete any file in your project
- **Run shell commands** — npm install, git, python, tests, builds, anything
- **Search code** — find text or patterns across your entire codebase
- **Build full apps** — give it a task like "build a REST API" and it will do it
- **Debug code** — show it an error and it will investigate and fix it
- **Understand your project** — it explores the file structure before acting

---

## Requirements

- **Node.js 18+** — https://nodejs.org (LTS version)
- **An OpenAI API key** — https://platform.openai.com/api-keys

---

## Setup

### 1. Install Node.js
Download from https://nodejs.org — use the LTS version.

### 2. Place the agent folder somewhere permanent
For example: `C:\Tools\local-agent` or `~/tools/local-agent`

### 3. Install dependencies (one time only)

Open a terminal in the `local-agent` folder:

```bash
npm install
```

### 4. Create your `.env` file

```bash
# On Mac/Linux:
cp .env.example .env

# On Windows (Command Prompt):
copy .env.example .env
```

Open `.env` and set your OpenAI API key:

```
OPENAI_API_KEY=sk-...your-key-here...
```

---

## Running it

### Option A — Run it from your project folder (recommended)

Open the VS Code terminal in your project, then:

```bash
node /path/to/local-agent/server.js
```

For example:
```bash
# Windows
node C:\Tools\local-agent\server.js

# Mac/Linux
node ~/tools/local-agent/server.js
```

Then open: **http://localhost:3000**

The agent will work on whichever folder you launched it from.

---

### Option B — Run from the agent folder, then change directory in the UI

```bash
cd /path/to/local-agent
npm start
```

Open **http://localhost:3000**, then click the pencil icon next to the working directory in the top-left sidebar to point it at your project.

---

### Option C — Add a shortcut script to your project

Create a file called `agent.bat` (Windows) or `agent.sh` (Mac/Linux) in your project root:

**Windows — `agent.bat`:**
```bat
@echo off
node C:\Tools\local-agent\server.js
```

**Mac/Linux — `agent.sh`:**
```bash
#!/bin/bash
node ~/tools/local-agent/server.js
```

Then just double-click it or run `./agent.sh` from the terminal.

---

## Configuration (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | *(required)* | Your OpenAI API key |
| `PORT` | `3000` | Web UI port |
| `AI_MODEL` | `gpt-4o` | AI model to use |
| `WORK_DIR` | *(launch directory)* | Override the working directory |
| `MAX_FILE_SIZE` | `100000` | Max characters per file read |

### Recommended models

| Model | Best for |
|-------|----------|
| `gpt-4o` | Complex tasks, best results (recommended) |
| `gpt-4o-mini` | Faster, cheaper, good for simple tasks |

---

## Tips

- **Start from your project folder** — the agent works best when launched from your project root
- **Be specific** — "Create a Node.js Express API with POST /api/users that validates the body with Zod and stores in SQLite" gets better results than "make an API"
- **Click any tool call** to expand and see exactly what the agent read/wrote/ran
- **The agent chains tools automatically** — it will explore, read, write, and run commands on its own to complete your task

---

## Stopping the agent

Press `Ctrl+C` in the terminal.

---

## Troubleshooting

**"API key not set" error:**
Make sure you created `.env` (not `.env.example`) and added your real key. Restart after editing.

**Port already in use:**
Change `PORT=3001` in `.env`.

**"Directory does not exist" when changing workdir:**
Enter the full absolute path, e.g. `C:\Users\you\myproject` or `/home/you/myproject`.

**The agent keeps running without finishing:**
Complex tasks can take many steps. Let it run — it will stop when done. You can always start a new chat.
