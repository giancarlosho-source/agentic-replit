import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

WORK_DIR = os.environ.get('WORK_DIR', os.getcwd())
MAX_FILE_SIZE = int(os.environ.get('MAX_FILE_SIZE', '100000'))


def set_work_dir(d):
    global WORK_DIR
    WORK_DIR = d


def get_work_dir():
    return WORK_DIR


def resolve_safe(file_path):
    p = Path(file_path)
    if p.is_absolute():
        return str(p)
    return str(Path(WORK_DIR) / file_path)


DEFAULT_IGNORE = {
    'node_modules', '.git', 'dist', 'build', '.next',
    '__pycache__', '.DS_Store', '.env', 'venv', '.venv',
    'env', '.mypy_cache', '.pytest_cache', '.tox'
}

IGNORE_EXTENSIONS = {'.pyc', '.pyo', '.pyd'}


def build_ignore_patterns():
    patterns = set(DEFAULT_IGNORE)
    gitignore = Path(WORK_DIR) / '.gitignore'
    if gitignore.exists():
        try:
            for line in gitignore.read_text(encoding='utf-8').splitlines():
                line = line.strip()
                if line and not line.startswith('#'):
                    patterns.add(line.rstrip('/'))
        except Exception:
            pass
    return patterns


def should_ignore(name, ignore_set):
    if name in ignore_set:
        return True
    ext = Path(name).suffix.lower()
    if ext in IGNORE_EXTENSIONS:
        return True
    for pat in ignore_set:
        if '*' in pat:
            regex = re.compile('^' + re.escape(pat).replace(r'\*', '.*') + '$')
            if regex.match(name):
                return True
    return False


def list_dir_recursive(directory, depth=0, max_depth=4, ignore_set=None):
    if ignore_set is None:
        ignore_set = set()
    if depth > max_depth:
        return []
    entries = []
    try:
        items = sorted(Path(directory).iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        for item in items:
            if should_ignore(item.name, ignore_set):
                continue
            try:
                rel = str(item.relative_to(WORK_DIR))
            except ValueError:
                rel = str(item)
            if item.is_dir():
                entries.append({'type': 'dir', 'path': rel, 'name': item.name})
                entries.extend(list_dir_recursive(item, depth + 1, max_depth, ignore_set))
            else:
                size = item.stat().st_size
                entries.append({'type': 'file', 'path': rel, 'name': item.name, 'size': size})
    except PermissionError:
        pass
    return entries


TOOL_DEFINITIONS = [
    {
        'type': 'function',
        'function': {
            'name': 'list_files',
            'description': 'List files and directories in the working directory or a subdirectory.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'path': {'type': 'string', 'description': 'Relative path to list. Use "." for the root.'},
                    'max_depth': {'type': 'number', 'description': 'How many levels deep to recurse. Default 3.'}
                },
                'required': ['path']
            }
        }
    },
    {
        'type': 'function',
        'function': {
            'name': 'read_file',
            'description': 'Read the contents of a file.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'path': {'type': 'string', 'description': 'Relative path to the file.'},
                    'start_line': {'type': 'number', 'description': '1-indexed line to start reading from.'},
                    'end_line': {'type': 'number', 'description': '1-indexed line to stop reading at (inclusive).'}
                },
                'required': ['path']
            }
        }
    },
    {
        'type': 'function',
        'function': {
            'name': 'write_file',
            'description': 'Create or completely overwrite a file with new content.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'path': {'type': 'string', 'description': 'Relative path to the file.'},
                    'content': {'type': 'string', 'description': 'The complete content to write.'}
                },
                'required': ['path', 'content']
            }
        }
    },
    {
        'type': 'function',
        'function': {
            'name': 'edit_file',
            'description': 'Make a targeted edit by replacing a specific string. The old_string must match exactly.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'path': {'type': 'string', 'description': 'Relative path to the file.'},
                    'old_string': {'type': 'string', 'description': 'The exact text to find and replace.'},
                    'new_string': {'type': 'string', 'description': 'The new text to replace it with.'}
                },
                'required': ['path', 'old_string', 'new_string']
            }
        }
    },
    {
        'type': 'function',
        'function': {
            'name': 'delete_file',
            'description': 'Delete a file or empty directory.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'path': {'type': 'string', 'description': 'Relative path to the file or directory.'}
                },
                'required': ['path']
            }
        }
    },
    {
        'type': 'function',
        'function': {
            'name': 'search_files',
            'description': 'Search for a text pattern across files in the project.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'pattern': {'type': 'string', 'description': 'Text or regex pattern to search for.'},
                    'path': {'type': 'string', 'description': 'Directory to search in. Default "."'},
                    'file_pattern': {'type': 'string', 'description': 'Glob pattern to filter files, e.g. "*.py"'},
                    'case_sensitive': {'type': 'boolean', 'description': 'Whether search is case sensitive. Default false.'}
                },
                'required': ['pattern']
            }
        }
    },
    {
        'type': 'function',
        'function': {
            'name': 'run_command',
            'description': 'Execute a shell command. Returns stdout and stderr.',
            'parameters': {
                'type': 'object',
                'properties': {
                    'command': {'type': 'string', 'description': 'The shell command to run.'},
                    'timeout_seconds': {'type': 'number', 'description': 'Timeout in seconds. Default 30, max 120.'},
                    'working_dir': {'type': 'string', 'description': 'Optional subdirectory to run the command in.'}
                },
                'required': ['command']
            }
        }
    }
]


def tool_list_files(path='.', max_depth=3, **_):
    abs_path = resolve_safe(path)
    depth = min(int(max_depth or 3), 6)
    ignore_set = build_ignore_patterns()
    entries = list_dir_recursive(abs_path, 0, depth, ignore_set)

    if not entries:
        return f'Directory is empty or does not exist: {path}'

    lines = []
    for e in entries:
        parts = Path(e['path']).parts
        indent = '  ' * (len(parts) - 1)
        if e['type'] == 'dir':
            lines.append(f"{indent}{e['name']}/")
        else:
            size = e['size']
            if size > 1024 * 1024:
                size_str = f"{size / 1024 / 1024:.1f}MB"
            elif size > 1024:
                size_str = f"{size / 1024:.1f}KB"
            else:
                size_str = f"{size}B"
            lines.append(f"{indent}{e['name']} ({size_str})")

    return f"Working directory: {WORK_DIR}\n\n" + '\n'.join(lines)


def tool_read_file(path, start_line=None, end_line=None, **_):
    abs_path = resolve_safe(path)
    if not os.path.exists(abs_path):
        return f'File not found: {path}'

    size = os.path.getsize(abs_path)
    if size > MAX_FILE_SIZE and not start_line:
        return f'File is large ({size / 1024:.1f}KB). Use start_line/end_line to read sections.'

    try:
        content = Path(abs_path).read_text(encoding='utf-8', errors='replace')
    except Exception as e:
        return f'Error reading file: {e}'

    lines = content.split('\n')
    total = len(lines)

    if start_line or end_line:
        s = int(start_line or 1) - 1
        e = int(end_line) if end_line else total
        sliced = lines[s:e]
        numbered = '\n'.join(f'{s + i + 1:6}  {l}' for i, l in enumerate(sliced))
        return f'File: {path} (lines {s + 1}-{min(e, total)} of {total})\n\n{numbered}'

    numbered = '\n'.join(f'{i + 1:6}  {l}' for i, l in enumerate(lines))
    return f'File: {path} ({total} lines)\n\n{numbered}'


def tool_write_file(path, content, **_):
    abs_path = resolve_safe(path)
    Path(abs_path).parent.mkdir(parents=True, exist_ok=True)
    Path(abs_path).write_text(content, encoding='utf-8')
    lines = content.count('\n') + 1
    return f'Written: {path} ({lines} lines, {len(content)} chars)'


def tool_edit_file(path, old_string, new_string, **_):
    abs_path = resolve_safe(path)
    if not os.path.exists(abs_path):
        return f'File not found: {path}'

    content = Path(abs_path).read_text(encoding='utf-8', errors='replace')
    count = content.count(old_string)

    if count == 0:
        return f'Error: old_string not found in {path}. Make sure it matches exactly including whitespace.'
    if count > 1:
        return f'Error: old_string appears {count} times in {path}. Make it more specific.'

    new_content = content.replace(old_string, new_string, 1)
    Path(abs_path).write_text(new_content, encoding='utf-8')
    return f'Edited: {path} — replaced 1 occurrence successfully.'


def tool_delete_file(path, **_):
    abs_path = resolve_safe(path)
    if not os.path.exists(abs_path):
        return f'Not found: {path}'

    if os.path.isdir(abs_path):
        try:
            os.rmdir(abs_path)
            return f'Deleted directory: {path}'
        except OSError:
            return f'Error: directory is not empty: {path}'

    os.remove(abs_path)
    return f'Deleted: {path}'


def tool_search_files(pattern, path='.', file_pattern=None, case_sensitive=False, **_):
    abs_path = resolve_safe(path)
    ignore_set = build_ignore_patterns()
    results = []
    flags = 0 if case_sensitive else re.IGNORECASE

    try:
        regex = re.compile(pattern, flags)
    except re.error:
        regex = re.compile(re.escape(pattern), flags)

    fp_regex = None
    if file_pattern:
        fp_regex = re.compile('^' + re.escape(file_pattern).replace(r'\*', '.*') + '$')

    def search_dir(directory):
        try:
            items = list(Path(directory).iterdir())
        except PermissionError:
            return

        for item in items:
            if should_ignore(item.name, ignore_set):
                continue
            if item.is_dir():
                search_dir(item)
            elif item.is_file():
                if fp_regex and not fp_regex.match(item.name):
                    continue
                try:
                    if item.stat().st_size > 1024 * 1024:
                        continue
                    content = item.read_text(encoding='utf-8', errors='replace')
                    for i, line in enumerate(content.split('\n')):
                        if regex.search(line):
                            try:
                                rel = str(item.relative_to(WORK_DIR))
                            except ValueError:
                                rel = str(item)
                            results.append(f'{rel}:{i + 1}: {line.strip()}')
                except Exception:
                    pass

    search_dir(abs_path)

    if not results:
        return f'No matches found for: {pattern}'
    if len(results) > 200:
        return '\n'.join(results[:200]) + f'\n\n... ({len(results) - 200} more matches truncated)'
    return f'Found {len(results)} match(es) for "{pattern}":\n\n' + '\n'.join(results)


def tool_run_command(command, timeout_seconds=30, working_dir=None, **_):
    timeout = min(int(timeout_seconds or 30), 120)
    cwd = resolve_safe(working_dir) if working_dir else WORK_DIR

    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            timeout=timeout,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace'
        )
        output = result.stdout or ''
        stderr = result.stderr or ''
        combined = output + stderr
        if result.returncode != 0:
            return f'$ {command}\n\nExit code: {result.returncode}\n{combined or "(no output)"}'
        return f'$ {command}\n\n{combined or "(no output)"}'
    except subprocess.TimeoutExpired:
        return f'$ {command}\n\nTimeout after {timeout}s'
    except Exception as e:
        return f'$ {command}\n\nError: {e}'


def execute_tool(name, args):
    dispatch = {
        'list_files': tool_list_files,
        'read_file': tool_read_file,
        'write_file': tool_write_file,
        'edit_file': tool_edit_file,
        'delete_file': tool_delete_file,
        'search_files': tool_search_files,
        'run_command': tool_run_command,
    }
    fn = dispatch.get(name)
    if fn is None:
        return f'Unknown tool: {name}'
    return fn(**args)
