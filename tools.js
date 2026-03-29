const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

let WORK_DIR = process.env.WORK_DIR || process.cwd();
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '100000');

function setWorkDir(dir) { WORK_DIR = dir; }
function getWorkDir() { return WORK_DIR; }

function resolveSafe(filePath) {
  const resolved = path.resolve(WORK_DIR, filePath);
  if (!resolved.startsWith(path.resolve(WORK_DIR))) {
    throw new Error('Path traversal outside working directory is not allowed.');
  }
  return resolved;
}

function buildIgnorePatterns() {
  const defaults = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.DS_Store', '*.pyc', '.env'];
  try {
    const gitignorePath = path.join(WORK_DIR, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const lines = fs.readFileSync(gitignorePath, 'utf-8').split('\n')
        .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      return [...new Set([...defaults, ...lines])];
    }
  } catch {}
  return defaults;
}

function shouldIgnore(name, ignoreList) {
  return ignoreList.some(pattern => {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      return regex.test(name);
    }
    return name === pattern;
  });
}

function listDirRecursive(dir, depth = 0, maxDepth = 4, ignoreList = []) {
  if (depth > maxDepth) return [];
  const entries = [];
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (shouldIgnore(item.name, ignoreList)) continue;
      const rel = path.relative(WORK_DIR, path.join(dir, item.name));
      if (item.isDirectory()) {
        entries.push({ type: 'dir', path: rel, name: item.name });
        const children = listDirRecursive(path.join(dir, item.name), depth + 1, maxDepth, ignoreList);
        entries.push(...children);
      } else {
        const stat = fs.statSync(path.join(dir, item.name));
        entries.push({ type: 'file', path: rel, name: item.name, size: stat.size });
      }
    }
  } catch {}
  return entries;
}

// ── Tool definitions for OpenAI ───────────────────────────────────────
const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories in the working directory or a subdirectory. Use this to understand the project structure before reading or writing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to list. Use "." for the root working directory.' },
          max_depth: { type: 'number', description: 'How many levels deep to recurse. Default 3, max 6.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Returns the file content as text.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file.' },
          start_line: { type: 'number', description: 'Optional: 1-indexed line to start reading from.' },
          end_line: { type: 'number', description: 'Optional: 1-indexed line to stop reading at (inclusive).' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or completely overwrite a file with new content. Use this for new files or when replacing the entire content. Creates parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file.' },
          content: { type: 'string', description: 'The complete content to write to the file.' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Make a targeted edit to an existing file by replacing a specific string with new content. The old_string must match exactly (including whitespace/indentation). Use this to make surgical edits without rewriting the whole file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file.' },
          old_string: { type: 'string', description: 'The exact text to find and replace. Must be unique in the file.' },
          new_string: { type: 'string', description: 'The new text to replace it with.' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file or empty directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file or directory to delete.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for a text pattern across files in the project. Like grep. Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Text or regex pattern to search for.' },
          path: { type: 'string', description: 'Directory to search in. Default "." for the whole project.' },
          file_pattern: { type: 'string', description: 'Optional glob pattern to filter files, e.g. "*.js" or "*.py".' },
          case_sensitive: { type: 'boolean', description: 'Whether search is case sensitive. Default false.' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command in the working directory. Use for running npm install, starting servers, running tests, git commands, etc. Returns stdout and stderr. Times out after 30 seconds by default.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
          timeout_seconds: { type: 'number', description: 'Timeout in seconds. Default 30, max 120.' },
          working_dir: { type: 'string', description: 'Optional subdirectory to run the command in, relative to the working directory.' }
        },
        required: ['command']
      }
    }
  }
];

// ── Tool implementations ──────────────────────────────────────────────
function toolListFiles({ path: dirPath = '.', max_depth = 3 }) {
  const absPath = resolveSafe(dirPath);
  const depth = Math.min(max_depth || 3, 6);
  const ignoreList = buildIgnorePatterns();
  const entries = listDirRecursive(absPath, 0, depth, ignoreList);

  if (entries.length === 0) {
    return `Directory is empty or does not exist: ${dirPath}`;
  }

  const lines = entries.map(e => {
    const indent = '  '.repeat(e.path.split(path.sep).length - 1);
    if (e.type === 'dir') return `${indent}${e.name}/`;
    const size = e.size > 1024 * 1024 ? `${(e.size / 1024 / 1024).toFixed(1)}MB`
               : e.size > 1024 ? `${(e.size / 1024).toFixed(1)}KB`
               : `${e.size}B`;
    return `${indent}${e.name} (${size})`;
  });

  return `Working directory: ${WORK_DIR}\n\n${lines.join('\n')}`;
}

function toolReadFile({ path: filePath, start_line, end_line }) {
  const absPath = resolveSafe(filePath);
  if (!fs.existsSync(absPath)) return `File not found: ${filePath}`;

  const stat = fs.statSync(absPath);
  if (stat.size > MAX_FILE_SIZE && !start_line) {
    return `File is large (${(stat.size/1024).toFixed(1)}KB). Use start_line/end_line to read sections. Total size: ${stat.size} bytes.`;
  }

  const content = fs.readFileSync(absPath, 'utf-8');
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (start_line || end_line) {
    const s = (start_line || 1) - 1;
    const e = end_line ? end_line : totalLines;
    const slice = lines.slice(s, e);
    const numbered = slice.map((l, i) => `${String(s + i + 1).padStart(6)}  ${l}`).join('\n');
    return `File: ${filePath} (lines ${s+1}-${Math.min(e, totalLines)} of ${totalLines})\n\n${numbered}`;
  }

  const numbered = lines.map((l, i) => `${String(i + 1).padStart(6)}  ${l}`).join('\n');
  return `File: ${filePath} (${totalLines} lines)\n\n${numbered}`;
}

function toolWriteFile({ path: filePath, content }) {
  const absPath = resolveSafe(filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf-8');
  const lines = content.split('\n').length;
  return `Written: ${filePath} (${lines} lines, ${content.length} chars)`;
}

function toolEditFile({ path: filePath, old_string, new_string }) {
  const absPath = resolveSafe(filePath);
  if (!fs.existsSync(absPath)) return `File not found: ${filePath}`;

  const content = fs.readFileSync(absPath, 'utf-8');
  const count = content.split(old_string).length - 1;

  if (count === 0) return `Error: The old_string was not found in ${filePath}. Make sure it matches exactly including whitespace.`;
  if (count > 1) return `Error: The old_string appears ${count} times in ${filePath}. Make it more specific to ensure a unique match.`;

  const newContent = content.replace(old_string, new_string);
  fs.writeFileSync(absPath, newContent, 'utf-8');
  return `Edited: ${filePath} — replaced 1 occurrence successfully.`;
}

function toolDeleteFile({ path: filePath }) {
  const absPath = resolveSafe(filePath);
  if (!fs.existsSync(absPath)) return `Not found: ${filePath}`;

  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    fs.rmdirSync(absPath);
    return `Deleted directory: ${filePath}`;
  }
  fs.unlinkSync(absPath);
  return `Deleted: ${filePath}`;
}

function toolSearchFiles({ pattern, path: searchPath = '.', file_pattern, case_sensitive = false }) {
  const absPath = resolveSafe(searchPath);
  const ignoreList = buildIgnorePatterns();
  const results = [];
  const flags = case_sensitive ? '' : 'i';
  let regex;

  try {
    regex = new RegExp(pattern, flags);
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }

  function searchDir(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (shouldIgnore(entry.name, ignoreList)) continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        searchDir(fullPath);
      } else if (entry.isFile()) {
        if (file_pattern) {
          const fpRegex = new RegExp('^' + file_pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
          if (!fpRegex.test(entry.name)) continue;
        }

        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > 1024 * 1024) continue;
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          lines.forEach((line, i) => {
            if (regex.test(line)) {
              results.push(`${path.relative(WORK_DIR, fullPath)}:${i + 1}: ${line.trim()}`);
            }
          });
        } catch {}
      }
    }
  }

  searchDir(absPath);

  if (results.length === 0) return `No matches found for: ${pattern}`;
  if (results.length > 200) return results.slice(0, 200).join('\n') + `\n\n... (${results.length - 200} more matches truncated)`;
  return `Found ${results.length} match(es) for "${pattern}":\n\n${results.join('\n')}`;
}

function toolRunCommand({ command, timeout_seconds = 30, working_dir }) {
  const timeout = Math.min((timeout_seconds || 30), 120) * 1000;
  const cwd = working_dir ? resolveSafe(working_dir) : WORK_DIR;

  try {
    const output = execSync(command, {
      cwd,
      timeout,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 5,
      shell: true
    });
    return `$ ${command}\n\n${output || '(no output)'}`;
  } catch (err) {
    const stdout = err.stdout || '';
    const stderr = err.stderr || '';
    if (err.signal === 'SIGTERM') {
      return `$ ${command}\n\nTimeout after ${timeout_seconds}s\n${stdout}${stderr}`;
    }
    return `$ ${command}\n\nExit code: ${err.status}\n${stdout}${stderr || err.message}`;
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────
function executeTool(name, args) {
  switch (name) {
    case 'list_files':    return toolListFiles(args);
    case 'read_file':     return toolReadFile(args);
    case 'write_file':    return toolWriteFile(args);
    case 'edit_file':     return toolEditFile(args);
    case 'delete_file':   return toolDeleteFile(args);
    case 'search_files':  return toolSearchFiles(args);
    case 'run_command':   return toolRunCommand(args);
    default:              return `Unknown tool: ${name}`;
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool, setWorkDir, getWorkDir };
