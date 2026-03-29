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
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let openai = null;

function getClient() {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key_here') return null;
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

const SYSTEM_PROMPT = () => `You are a highly capable local AI coding agent running on the user's machine. You are similar to Replit Agent — you can autonomously build, edit, debug, and run full software projects.

You have access to the following tools:
- list_files: explore the file and folder structure
- read_file: read any file's contents (with optional line ranges)
- write_file: create or overwrite files
- edit_file: make targeted edits to existing files (find-and-replace)
- delete_file: delete files
- search_files: search for text or patterns across the codebase (like grep)
- run_command: execute any shell command (npm install, git, python, etc.)

Working directory: ${getWorkDir()}
Current date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

## How you work:
1. Before doing anything, orient yourself with list_files to understand the project structure.
2. Read relevant files before editing them — never guess at existing content.
3. Make changes incrementally and verify by reading back what you wrote.
4. Run commands to install dependencies, test, and verify your work.
5. Be thorough — don't stop halfway. Finish the full task before reporting back.
6. When writing code, follow existing conventions in the codebase.

## Important rules:
- Always use edit_file for small changes to existing files (it's safer than rewriting the whole file).
- Use write_file for new files or when rewriting the entire content is necessary.
- When running long commands (servers, builds), use appropriate timeouts.
- If a command fails, read the error carefully and fix the underlying issue.
- You can chain multiple tool calls to complete complex tasks — keep going until the task is done.
- Be concise in your final responses. Show what you did, not every detail of how.`;

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
    const MAX_ITERATIONS = 30;

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
