import json
import os
import ssl
import socket

try:
    import openai
    from openai import OpenAI, AzureOpenAI
    _openai_available = True
except ImportError:
    _openai_available = False

try:
    import anthropic as _anthropic_module
    _anthropic_available = True
except ImportError:
    _anthropic_available = False


# ── Format converters ─────────────────────────────────────────────────────────

def to_anthropic_tools(tools):
    return [
        {
            'name': t['function']['name'],
            'description': t['function'].get('description', ''),
            'input_schema': t['function']['parameters']
        }
        for t in tools
    ]


def to_anthropic_messages(messages):
    system = ''
    converted = []

    for msg in messages:
        role = msg.get('role')

        if role == 'system':
            system = msg.get('content', '')
            continue

        if role == 'user':
            converted.append({'role': 'user', 'content': msg.get('content', '')})
            continue

        if role == 'assistant':
            tool_calls = msg.get('tool_calls', [])
            if tool_calls:
                content = []
                if msg.get('content'):
                    content.append({'type': 'text', 'text': msg['content']})
                for tc in tool_calls:
                    try:
                        inp = json.loads(tc['function']['arguments'])
                    except Exception:
                        inp = {}
                    content.append({
                        'type': 'tool_use',
                        'id': tc['id'],
                        'name': tc['function']['name'],
                        'input': inp
                    })
                converted.append({'role': 'assistant', 'content': content})
            else:
                converted.append({'role': 'assistant', 'content': msg.get('content', '')})
            continue

        if role == 'tool':
            tool_result = {
                'type': 'tool_result',
                'tool_use_id': msg.get('tool_call_id', ''),
                'content': msg.get('content', '')
            }
            # Group multiple tool results into one user message
            if (converted and converted[-1]['role'] == 'user'
                    and isinstance(converted[-1]['content'], list)
                    and converted[-1]['content']
                    and converted[-1]['content'][0].get('type') == 'tool_result'):
                converted[-1]['content'].append(tool_result)
            else:
                converted.append({'role': 'user', 'content': [tool_result]})
            continue

    return system, converted


def from_anthropic_response(response):
    content = response.content or []
    text_parts = [c for c in content if c.type == 'text']
    tool_uses = [c for c in content if c.type == 'tool_use']

    message = {
        'role': 'assistant',
        'content': ''.join(t.text for t in text_parts) or None
    }

    if tool_uses:
        message['tool_calls'] = [
            {
                'id': tu.id,
                'type': 'function',
                'function': {
                    'name': tu.name,
                    'arguments': json.dumps(tu.input or {})
                }
            }
            for tu in tool_uses
        ]

    finish_reason = 'tool_calls' if response.stop_reason == 'tool_use' else 'stop'
    return {'message': message, 'finish_reason': finish_reason}


def from_openai_response(response):
    choice = response.choices[0]
    msg = choice.message

    message = {
        'role': 'assistant',
        'content': msg.content
    }

    if msg.tool_calls:
        message['tool_calls'] = [
            {
                'id': tc.id,
                'type': 'function',
                'function': {
                    'name': tc.function.name,
                    'arguments': tc.function.arguments
                }
            }
            for tc in msg.tool_calls
        ]

    return {'message': message, 'finish_reason': choice.finish_reason}


# ── Blocked-request detection ─────────────────────────────────────────────────

def is_blocked(err):
    msg = str(err).lower()

    # API-level blocks
    status = getattr(err, 'status_code', None) or getattr(err, 'status', None)
    if status in (401, 403, 429):
        return True

    api_keywords = [
        'unauthorized', 'invalid api key', 'invalid_api_key',
        'authentication', 'quota', 'rate limit', 'billing',
        'permission', 'not configured', 'access denied'
    ]
    if any(k in msg for k in api_keywords):
        return True

    # Network / SSL / proxy blocks
    network_keywords = [
        'ssl', 'certificate', 'self-signed', 'network error',
        'fetch failed', 'connect timeout', 'connection reset',
        'connection refused', 'socket hang up', 'blocked',
        'proxy', 'firewall', 'zscaler', 'connection error',
        'name or service not known', 'temporary failure in name resolution',
        'no route to host', 'network is unreachable'
    ]
    if any(k in msg for k in network_keywords):
        return True

    # Check for specific exception types
    if _openai_available:
        if isinstance(err, (
            openai.APIConnectionError,
            openai.AuthenticationError,
            openai.PermissionDeniedError,
            openai.RateLimitError
        )):
            return True

    if _anthropic_available:
        if isinstance(err, (
            _anthropic_module.APIConnectionError,
            _anthropic_module.AuthenticationError,
            _anthropic_module.PermissionDeniedError,
            _anthropic_module.RateLimitError
        )):
            return True

    # Check the cause chain for network errors
    cause = getattr(err, '__cause__', None) or getattr(err, '__context__', None)
    if cause:
        if isinstance(cause, (ssl.SSLError, socket.gaierror, socket.timeout,
                               ConnectionError, ConnectionResetError,
                               ConnectionRefusedError, TimeoutError)):
            return True
        cause_msg = str(cause).lower()
        if any(k in cause_msg for k in network_keywords):
            return True

    return False


def block_reason(err):
    msg = str(err).lower()

    if any(k in msg for k in ['ssl', 'certificate', 'self-signed', 'tls']):
        return 'SSL/certificate error (possible proxy inspection)'
    if 'zscaler' in msg or 'proxy' in msg or 'firewall' in msg or 'blocked' in msg:
        return 'blocked by network/proxy'
    if 'connection reset' in msg or 'connection refused' in msg:
        return 'connection reset/refused'
    if 'timeout' in msg:
        return 'connection timed out'
    if 'name or service not known' in msg or 'name resolution' in msg:
        return 'host not found (DNS blocked?)'
    if 'unreachable' in msg:
        return 'network unreachable'

    status = getattr(err, 'status_code', None) or getattr(err, 'status', None)
    if status == 401:
        return 'authentication error'
    if status == 403:
        return 'access denied'
    if status == 429:
        return 'rate limit / quota exceeded'

    return str(err) or 'unavailable'


# ── Individual provider calls ─────────────────────────────────────────────────

def call_anthropic(messages, tools):
    if not _anthropic_available:
        raise Exception('anthropic SDK not installed')
    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        raise Exception('Anthropic not configured')

    client = _anthropic_module.Anthropic(api_key=api_key)
    model = os.environ.get('ANTHROPIC_MODEL', 'claude-3-5-sonnet-20241022')
    system, anthropic_messages = to_anthropic_messages(messages)

    response = client.messages.create(
        model=model,
        max_tokens=4096,
        system=system or _anthropic_module.NOT_GIVEN,
        messages=anthropic_messages,
        tools=to_anthropic_tools(tools)
    )

    return {'provider': 'Anthropic', 'model': model, **from_anthropic_response(response)}


def call_azure(messages, tools):
    if not _openai_available:
        raise Exception('openai SDK not installed')
    azure_key = os.environ.get('AZURE_KEY') or os.environ.get('AZURE_OPENAI_API_KEY')
    azure_endpoint = os.environ.get('AZURE_ENDPOINT') or os.environ.get('AZURE_OPENAI_ENDPOINT')
    if not azure_key or not azure_endpoint:
        raise Exception('Azure OpenAI not configured')

    deployment = (os.environ.get('AZURE_DEPLOYMENT')
                  or os.environ.get('AZURE_OPENAI_DEPLOYMENT')
                  or 'gpt-4o')
    api_version = os.environ.get('AZURE_OPENAI_API_VERSION', '2025-01-01-preview')

    client = AzureOpenAI(
        api_key=azure_key,
        azure_endpoint=azure_endpoint,
        api_version=api_version
    )

    response = client.chat.completions.create(
        model=deployment,
        messages=messages,
        tools=tools,
        tool_choice='auto',
        temperature=0.3,
        max_tokens=4096
    )

    return {'provider': 'Azure OpenAI', 'model': deployment, **from_openai_response(response)}


def call_openai(messages, tools):
    if not _openai_available:
        raise Exception('openai SDK not installed')
    key = os.environ.get('OPENAI_API_KEY')
    if not key or key == 'your_openai_api_key_here':
        raise Exception('OpenAI not configured')

    model = os.environ.get('AI_MODEL', 'gpt-4o')
    client = OpenAI(api_key=key)

    response = client.chat.completions.create(
        model=model,
        messages=messages,
        tools=tools,
        tool_choice='auto',
        temperature=0.3,
        max_tokens=4096
    )

    return {'provider': 'OpenAI', 'model': model, **from_openai_response(response)}


def call_github(messages, tools):
    if not _openai_available:
        raise Exception('openai SDK not installed')
    token = os.environ.get('GITHUB_TOKEN')
    if not token:
        raise Exception('GitHub not configured')

    model = os.environ.get('GITHUB_MODEL', 'gpt-4o')
    client = OpenAI(
        base_url='https://models.inference.ai.azure.com',
        api_key=token
    )

    response = client.chat.completions.create(
        model=model,
        messages=messages,
        tools=tools,
        tool_choice='auto',
        temperature=0.3,
        max_tokens=4096
    )

    return {'provider': 'GitHub Models', 'model': model, **from_openai_response(response)}


# ── Public API ────────────────────────────────────────────────────────────────

PROVIDER_CHAIN = [
    ('Anthropic', call_anthropic),
    ('Azure OpenAI', call_azure),
    ('OpenAI', call_openai),
    ('GitHub Models', call_github),
]


def call_with_fallback(messages, tools, on_fallback=None):
    last_error = None
    for name, fn in PROVIDER_CHAIN:
        try:
            return fn(messages, tools)
        except Exception as err:
            if is_blocked(err):
                reason = block_reason(err)
                print(f'[providers] {name} blocked: {reason}')
                if on_fallback:
                    on_fallback(name, reason)
                last_error = err
                continue
            raise
    raise last_error or Exception('All providers failed or none are configured')


def get_provider_status():
    azure_key = os.environ.get('AZURE_KEY') or os.environ.get('AZURE_OPENAI_API_KEY')
    azure_endpoint = os.environ.get('AZURE_ENDPOINT') or os.environ.get('AZURE_OPENAI_ENDPOINT')
    openai_key = os.environ.get('OPENAI_API_KEY', '')
    return {
        'anthropic': bool(_anthropic_available and os.environ.get('ANTHROPIC_API_KEY')),
        'azure': bool(azure_key and azure_endpoint),
        'openai': bool(openai_key and openai_key != 'your_openai_api_key_here'),
        'github': bool(os.environ.get('GITHUB_TOKEN'))
    }


def is_any_provider_ready():
    s = get_provider_status()
    return s['anthropic'] or s['azure'] or s['openai'] or s['github']


def get_active_provider_name():
    s = get_provider_status()
    if s['anthropic']:
        return 'Anthropic'
    if s['azure']:
        return 'Azure OpenAI'
    if s['openai']:
        return 'OpenAI'
    if s['github']:
        return 'GitHub Models'
    return None
