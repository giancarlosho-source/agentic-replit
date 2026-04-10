import json
import os
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

from flask import Flask, Response, jsonify, request, send_from_directory

from providers import (call_with_fallback, get_active_provider_name,
                       get_provider_status, is_any_provider_ready)
from tools import (TOOL_DEFINITIONS, execute_tool, get_work_dir, set_work_dir)

app = Flask(__name__, static_folder='public', static_url_path='')

PORT = int(os.environ.get('PORT', 5000))

if os.environ.get('WORK_DIR'):
    set_work_dir(os.environ['WORK_DIR'])


def system_prompt():
    now = datetime.now().strftime('%A, %B %d, %Y')
    return f"""You are a fully autonomous AI coding agent running on the user's machine. Your job is to complete tasks end-to-end without asking questions. You plan, build, test, fix errors, and verify — all on your own — until the task is 100% done.

Working directory: {get_work_dir()}
Current date: {now}

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
- You can read and write files anywhere on the machine using absolute paths.
- If the user says "my file is at X", go read it immediately — do not ask them to copy/paste it.
- Relative paths resolve from the working directory: {get_work_dir()}

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
- Do NOT include a wall of code in your response — the code is already in the files."""


# ── CORS headers ──────────────────────────────────────────────────────────────

@app.after_request
def add_cors(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return response


@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_static(path):
    if path and (Path(app.static_folder) / path).exists():
        return send_from_directory(app.static_folder, path)
    return send_from_directory(app.static_folder, 'index.html')


# ── Status endpoint ───────────────────────────────────────────────────────────

@app.route('/api/status')
def api_status():
    ready = is_any_provider_ready()
    active = get_active_provider_name()
    providers = get_provider_status()
    return jsonify({
        'ready': ready,
        'providers': providers,
        'activeProvider': active,
        'workDir': get_work_dir(),
        'message': f'Ready · {active}' if ready else 'No API key set'
    })


# ── Set working directory ─────────────────────────────────────────────────────

@app.route('/api/workdir', methods=['POST'])
def api_workdir():
    data = request.get_json() or {}
    d = data.get('dir', '').strip()
    if not d:
        return jsonify({'error': 'dir is required'}), 400
    if not os.path.isdir(d):
        return jsonify({'error': 'Directory does not exist'}), 400
    set_work_dir(d)
    return jsonify({'workDir': get_work_dir()})


# ── Main agent endpoint (SSE streaming) ───────────────────────────────────────

@app.route('/api/agent', methods=['POST'])
def api_agent():
    data = request.get_json() or {}
    messages = data.get('messages', [])

    if not isinstance(messages, list) or not messages:
        return jsonify({'error': 'messages array is required'}), 400

    if not is_any_provider_ready():
        return jsonify({
            'error': 'No API key configured. Add at least one key to your .env file and restart.'
        }), 503

    def generate():
        def sse(event_type, payload):
            return f"data: {json.dumps({'type': event_type, **payload})}\n\n"

        try:
            conversation = [{'role': 'system', 'content': system_prompt()}] + messages
            MAX_ITERATIONS = 50

            for _ in range(MAX_ITERATIONS):
                fallback_events = []

                def on_fallback(from_provider, reason):
                    fallback_events.append({'from': from_provider, 'reason': reason})

                result = call_with_fallback(conversation, TOOL_DEFINITIONS, on_fallback=on_fallback)

                for ev in fallback_events:
                    yield sse('provider_switch', ev)

                msg = result['message']
                conversation.append(msg)

                tool_calls = msg.get('tool_calls', [])
                if tool_calls:
                    for tc in tool_calls:
                        tool_name = tc['function']['name']
                        try:
                            tool_args = json.loads(tc['function']['arguments'])
                        except Exception:
                            tool_args = {}

                        yield sse('tool_start', {
                            'tool': tool_name,
                            'args': tool_args,
                            'callId': tc['id']
                        })

                        try:
                            tool_result = execute_tool(tool_name, tool_args)
                        except Exception as e:
                            tool_result = f'Error executing {tool_name}: {e}'

                        display_result = tool_result[:2000] + (' (truncated)' if len(tool_result) > 2000 else '')
                        yield sse('tool_result', {
                            'tool': tool_name,
                            'callId': tc['id'],
                            'result': display_result
                        })

                        conversation.append({
                            'role': 'tool',
                            'tool_call_id': tc['id'],
                            'content': tool_result
                        })
                    continue

                reply = msg.get('content') or '(Task completed)'
                yield sse('done', {'reply': reply})
                return

            yield sse('done', {'reply': 'Reached maximum iteration limit. The task may be incomplete.'})

        except Exception as e:
            print(f'Agent error: {e}')
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        }
    )


# ── File tree for sidebar ─────────────────────────────────────────────────────

@app.route('/api/files')
def api_files():
    try:
        result = execute_tool('list_files', {'path': '.', 'max_depth': 4})
        return jsonify({'tree': result, 'workDir': get_work_dir()})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── Startup ───────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    ready = is_any_provider_ready()
    active = get_active_provider_name()
    providers = get_provider_status()

    print('')
    print('  ╔══════════════════════════════════════╗')
    print('  ║       Local AI Coding Agent          ║')
    print('  ║            (Python)                  ║')
    print('  ╚══════════════════════════════════════╝')
    print('')
    print(f'  Open in browser: http://localhost:{PORT}')
    print(f'  Working on:      {get_work_dir()}')
    print('')

    if ready:
        print(f'  ✓  Active provider: {active}')
        print('')
        print('  Configured providers:')
        if providers['anthropic']:
            print('    ✓ Anthropic')
        if providers['azure']:
            print('    ✓ Azure OpenAI')
        if providers['openai']:
            print('    ✓ OpenAI')
        if providers['github']:
            print('    ✓ GitHub Models')
        print('')
    else:
        print('  ⚠  No API key detected.')
        print('     Add at least one key to your .env file:')
        print('       ANTHROPIC_API_KEY   — Anthropic Claude')
        print('       AZURE_KEY + AZURE_ENDPOINT + AZURE_DEPLOYMENT — Azure OpenAI')
        print('       OPENAI_API_KEY      — OpenAI')
        print('       GITHUB_TOKEN        — GitHub Models')
        print('     Then restart: python server.py')
        print('')

    print('  TIP: Run from your project folder for best results:')
    print('    cd /path/to/your/project && python /path/to/python-agent/server.py')
    print('')

    app.run(host='0.0.0.0', port=PORT, debug=False, threaded=True)
