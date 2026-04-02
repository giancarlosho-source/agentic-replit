# VS Code Setup Guide

This guide walks you through setting up and running the Local AI Coding Agent inside Visual Studio Code.

---

## Step 1 — Install Node.js

1. Go to https://nodejs.org
2. Download the **LTS** version (the left button)
3. Run the installer with all default options
4. Verify it installed by opening a terminal and running:

```bash
node --version
```

You should see something like `v20.x.x`.

---

## Step 2 — Get an OpenAI API Key

1. Go to https://platform.openai.com/api-keys
2. Sign in or create a free account
3. Click **Create new secret key**
4. Copy the key — you'll need it in Step 4

> **Cost:** The default model (`gpt-4o`) costs roughly $0.005–$0.02 per task. Add a spend limit at https://platform.openai.com/settings/organization/limits if you want to be safe.

---

## Step 3 — Set up the agent folder

1. Download or clone this repository to a permanent location on your machine, for example:
   - Windows: `C:\Tools\local-agent`
   - Mac/Linux: `~/tools/local-agent`

2. Open VS Code

3. Open the **integrated terminal** in VS Code:
   - Menu: **Terminal → New Terminal**
   - Or press `` Ctrl+` `` (backtick)

4. In the terminal, navigate to the agent folder:

```bash
# Windows
cd C:\Tools\local-agent

# Mac/Linux
cd ~/tools/local-agent
```

5. Install dependencies (one time only):

```bash
npm install
```

---

## Step 4 — Configure your API key

1. In the terminal (still in the agent folder), create your `.env` file:

```bash
# Mac/Linux
cp .env.example .env

# Windows Command Prompt
copy .env.example .env
```

2. In VS Code, open the `.env` file (it will now appear in the file explorer)

3. Replace `your_openai_api_key_here` with your actual key:

```
OPENAI_API_KEY=sk-proj-...your real key here...
```

4. Save the file (`Ctrl+S`)

> **Important:** Never commit your `.env` file to Git. It's already in `.gitignore` so this is handled automatically.

---

## Step 5 — Run the agent on your project

### The recommended way — launch FROM your project folder

1. In VS Code, open the project you want to work on (**File → Open Folder**)

2. Open the terminal (`` Ctrl+` ``)

3. Run the agent, pointing at where you installed it:

```bash
# Windows
node C:\Tools\local-agent\server.js

# Mac/Linux
node ~/tools/local-agent/server.js
```

4. You'll see:
```
  Open in browser: http://localhost:5000
  Working on:      /path/to/your/project
```

5. Open your browser and go to **http://localhost:5000**

The agent is now running on your project folder. You can chat with it to build, edit, debug, or explain code.

---

## Step 6 — Optional: Create a launch shortcut

To avoid typing the full path every time, add a small script to each of your projects.

**Windows — create `run-agent.bat` in your project root:**
```bat
@echo off
node C:\Tools\local-agent\server.js
```

**Mac/Linux — create `run-agent.sh` in your project root:**
```bash
#!/bin/bash
node ~/tools/local-agent/server.js
```

Then make it executable (Mac/Linux only):
```bash
chmod +x run-agent.sh
```

Now you can just run `run-agent.bat` or `./run-agent.sh` from the VS Code terminal.

---

## Step 7 — Optional: Add a VS Code Task

You can make the agent launchable from the VS Code command palette.

1. In your project, create the folder `.vscode/` if it doesn't exist
2. Create the file `.vscode/tasks.json` with:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Start AI Agent",
      "type": "shell",
      "command": "node C:\\Tools\\local-agent\\server.js",
      "presentation": {
        "reveal": "always",
        "panel": "new"
      },
      "problemMatcher": []
    }
  ]
}
```

> On Mac/Linux, change the command to `node ~/tools/local-agent/server.js`

3. Now launch it anytime with:
   - **Terminal → Run Task → Start AI Agent**
   - Or `Ctrl+Shift+P` → "Tasks: Run Task" → "Start AI Agent"

---

## Changing the working directory at runtime

If you launched the agent from the wrong folder, you don't need to restart. In the web UI:

1. Click the **pencil icon** next to the working directory in the top-left sidebar
2. Enter the full path to your project folder
3. Click **Change**

The agent will now work on that folder.

---

## Stopping the agent

Press `Ctrl+C` in the VS Code terminal where the agent is running.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `node: command not found` | Install Node.js from https://nodejs.org and restart VS Code |
| `Cannot find module` | Run `npm install` in the local-agent folder |
| Port 5000 already in use | Add `PORT=3001` to your `.env` file |
| "API key not set" in the UI | Check your `.env` file has the real key, then restart the server |
| "Invalid API key" error | Make sure you copied the full key — it starts with `sk-` |
| Page won't load | Make sure the server is still running in the terminal (not stopped) |
