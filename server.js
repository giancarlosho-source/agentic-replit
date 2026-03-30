require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { OpenAI } = require('openai');
const { TOOL_DEFINITIONS, executeTool, setWorkDir, getWorkDir } = require('./tools');

const app = express();
const PORT = process.env.PORT || 3000;
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o';

if (process.env.WORK_DIR) setWorkDir(process.env.WORK_DIR);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let openai = null;

function getClient() {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key_here') return null;
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

const SYSTEM_PROMPT = () => `You are a fully autonomous AI coding agent running on the user's machine. Your job is to complete tasks end-to-end without asking questions. You plan, build, test, fix errors, and verify — all on your own — until the task is 100% done.

Working directory: ${getWorkDir()}
Current date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

## Your tools:
- list_files(path, max_depth) — explore folder structure
- read_file(path, start_line?, end_line?) — read any file, supports absolute paths
- write_file(path, content) — create or fully overwrite a file
- edit_file(path, old_string, new_string) — surgical find-and-replace in an existing file
- delete_file(path) — delete a file or empty folder
- search_files(pattern, path?, file_pattern?, case_sensitive?) — grep across codebase
- run_command(command, timeout_seconds?, working_dir?) — run any shell command

## CORE RULES — follow these without exception:

### 1. NEVER ask questions. Ever.
- Do not ask for clarification, confirmation, preferences, or permission.
- If something is ambiguous, make the most reasonable assumption and state it as a decision in your final summary.
- If the user gives you a folder path, file path, or description — use it directly. Do not ask if it's correct.
- The only time you stop is when the task is fully complete and verified.

### 2. Work autonomously from start to finish.
- Read the instructions once, plan the full approach in your head, then execute.
- Do not pause mid-task to report progress or ask if you should continue.
- Chain as many tool calls as needed. 30 steps, 50 steps — keep going until done.

### 3. Always test your work.
- After writing or editing code, immediately run it.
- If it uses Python: run_command("python script.py") or ("python -m pytest")
- If it uses Node.js: run_command("node script.js") or ("npm test")
- If it uses a build step: run the build and check for errors.
- Read the full output carefully.

### 4. Fix errors automatically. Never give up.
- If a command fails, read the full error message.
- Diagnose the root cause yourself — don't ask the user what went wrong.
- Fix it, then run again.
- Repeat until it passes. This is the loop: write → run → read error → fix → run again.
- If one approach doesn't work after 2–3 attempts, try a different approach entirely.

### 5. Access any file the user mentions.
- You can read and write files anywhere on the machine using absolute paths (e.g. C:\\Users\\name\\project\\file.py or /home/user/project/file.py).
- If the user says "my file is at X", go read it immediately — do not ask them to copy/paste it.
- Relative paths resolve from the working directory: ${getWorkDir()}

### 6. Handle file edits carefully.
- Always read a file before editing it — never guess at existing content.
- Use edit_file for targeted changes (safer than rewriting).
- Use write_file only for new files or when a full rewrite is needed.
- After editing, read the file back to verify the change looks correct.

### 7. Install dependencies without asking.
- If code needs a library, install it immediately: pip install X, npm install X, etc.
- Don't ask the user if it's okay to install things.

### 8. Complete the FULL task, not a partial version.
- "Translate this VBA to Python" means: read the VBA → write Python → install deps → run → fix errors → run again → confirm it works.
- "Build a REST API" means: scaffold → write all endpoints → install deps → start server → test endpoints → fix any issues → confirm it runs.
- Only report back when the entire task is done and verified.

### 9. Your final response should be a clean summary.
- What you built or changed (brief)
- Any assumptions you made
- How to run or use what you created
- Do NOT include a wall of code in your response — the code is already in the files.`;


// ── Status endpoint ───────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const client = getClient();
  res.json({
    ready: !!client,
    model: AI_MODEL,
    workDir: getWorkDir(),
    message: client ? `Ready · ${AI_MODEL}` : 'API key not set'
  });
});

// ── Set working directory ─────────────────────────────────────────────
app.post('/api/workdir', (req, res) => {
  const { dir } = req.body;
  if (!dir) return res.status(400).json({ error: 'dir is required' });
  if (!fs.existsSync(dir)) return res.status(400).json({ error: 'Directory does not exist' });
  setWorkDir(dir);
  res.json({ workDir: getWorkDir() });
});

// ── Main agent endpoint (SSE streaming) ──────────────────────────────
app.post('/api/agent', async (req, res) => {
  const { messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const client = getClient();
  if (!client) {
    return res.status(503).json({ error: 'OpenAI API key not configured. Add it to your .env file and restart.' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  function send(type, data) {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }

  try {
    const conversationMessages = [
      { role: 'system', content: SYSTEM_PROMPT() },
      ...messages
    ];

    let iterationCount = 0;
    const MAX_ITERATIONS = 50;

    while (iterationCount < MAX_ITERATIONS) {
      iterationCount++;

      const response = await client.chat.completions.create({
        model: AI_MODEL,
        messages: conversationMessages,
        tools: TOOL_DEFINITIONS,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens: 4096
      });

      const choice = response.choices[0];
      const msg = choice.message;
      conversationMessages.push(msg);

      // If the AI wants to call tools
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const toolCall of msg.tool_calls) {
          const toolName = toolCall.function.name;
          let toolArgs;
          try {
            toolArgs = JSON.parse(toolCall.function.arguments);
          } catch {
            toolArgs = {};
          }

          // Tell the frontend a tool is being called
          send('tool_start', {
            tool: toolName,
            args: toolArgs,
            callId: toolCall.id
          });

          // Execute the tool
          let result;
          try {
            result = executeTool(toolName, toolArgs);
          } catch (err) {
            result = `Error executing ${toolName}: ${err.message}`;
          }

          // Send result to frontend
          send('tool_result', {
            tool: toolName,
            callId: toolCall.id,
            result: result.slice(0, 2000) + (result.length > 2000 ? '\n... (truncated for display)' : '')
          });

          // Add tool result to conversation
          conversationMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result
          });
        }

        // Continue the loop to let the AI process tool results
        continue;
      }

      // No more tool calls — AI is done
      if (msg.content) {
        send('done', { reply: msg.content });
      } else {
        send('done', { reply: '(Task completed)' });
      }

      res.end();
      return;
    }

    send('done', { reply: 'Reached maximum iteration limit. The task may be incomplete.' });
    res.end();

  } catch (err) {
    console.error('Agent error:', err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message });
    }
    send('error', { message: err.message });
    res.end();
  }
});

// ── File tree for sidebar ─────────────────────────────────────────────
app.get('/api/files', (req, res) => {
  const { executeTool: exec } = require('./tools');
  try {
    const result = executeTool('list_files', { path: '.', max_depth: 4 });
    res.json({ tree: result, workDir: getWorkDir() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║       Local AI Coding Agent          ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  Open in browser: http://localhost:${PORT}`);
  console.log(`  Working on:      ${getWorkDir()}`);
  console.log(`  Model:           ${AI_MODEL}`);
  console.log('');

  if (!getClient()) {
    console.log('  ⚠  No API key detected.');
    console.log('     1. Copy .env.example to .env');
    console.log('     2. Add your OpenAI API key');
    console.log('     3. Restart: Ctrl+C, then npm start');
    console.log('');
  } else {
    console.log('  ✓  Agent ready. Start chatting!');
    console.log('');
  }

  console.log('  TIP: Run from your project folder for best results:');
  console.log('    cd /path/to/your/project && node /path/to/local-agent/server.js');
  console.log('');
});
