require('dotenv').config();
const { OpenAI, AzureOpenAI } = require('openai');

let Anthropic;
try {
  Anthropic = require('@anthropic-ai/sdk').Anthropic;
} catch (e) {
  Anthropic = null;
}

// ── Format converters ─────────────────────────────────────────────────────────

function toAnthropicTools(tools) {
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters
  }));
}

function toAnthropicMessages(messages) {
  let system = '';
  const converted = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system = msg.content || '';
      continue;
    }

    if (msg.role === 'user') {
      converted.push({ role: 'user', content: msg.content || '' });
      continue;
    }

    if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const content = [];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        for (const tc of msg.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function.arguments); } catch {}
          content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
        converted.push({ role: 'assistant', content });
      } else {
        converted.push({ role: 'assistant', content: msg.content || '' });
      }
      continue;
    }

    if (msg.role === 'tool') {
      const toolResult = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: msg.content || ''
      };
      const last = converted[converted.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) &&
          last.content.length > 0 && last.content[0].type === 'tool_result') {
        last.content.push(toolResult);
      } else {
        converted.push({ role: 'user', content: [toolResult] });
      }
      continue;
    }
  }

  return { system, messages: converted };
}

function fromAnthropicResponse(response) {
  const content = response.content || [];
  const textParts = content.filter(c => c.type === 'text');
  const toolUses = content.filter(c => c.type === 'tool_use');

  const message = {
    role: 'assistant',
    content: textParts.map(t => t.text).join('') || null
  };

  if (toolUses.length > 0) {
    message.tool_calls = toolUses.map(tu => ({
      id: tu.id,
      type: 'function',
      function: {
        name: tu.name,
        arguments: JSON.stringify(tu.input || {})
      }
    }));
  }

  return { message, finishReason: response.stop_reason === 'tool_use' ? 'tool_calls' : 'stop' };
}

function fromOpenAIResponse(response) {
  const choice = response.choices[0];
  return { message: choice.message, finishReason: choice.finish_reason };
}

// ── Blocked-request detection ─────────────────────────────────────────────────

function isBlocked(err) {
  const status = err.status || err.statusCode || (err.error && err.error.status);
  const msg = (err.message || '').toLowerCase();
  return (
    status === 401 || status === 403 || status === 429 ||
    msg.includes('unauthorized') ||
    msg.includes('invalid api key') ||
    msg.includes('invalid_api_key') ||
    msg.includes('authentication') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('billing') ||
    msg.includes('permission') ||
    msg.includes('not configured') ||
    msg.includes('access denied')
  );
}

// ── Individual provider calls ─────────────────────────────────────────────────

async function callAnthropic(messages, tools) {
  if (!Anthropic) throw Object.assign(new Error('Anthropic SDK not installed'), { status: 401 });
  if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error('Anthropic not configured'), { status: 401 });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: system || undefined,
    messages: anthropicMessages,
    tools: toAnthropicTools(tools)
  });

  return { provider: 'Anthropic', model, ...fromAnthropicResponse(response) };
}

async function callAzure(messages, tools) {
  if (!process.env.AZURE_OPENAI_API_KEY || !process.env.AZURE_OPENAI_ENDPOINT) {
    throw Object.assign(new Error('Azure OpenAI not configured'), { status: 401 });
  }

  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
  const client = new AzureOpenAI({
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview',
    deployment
  });

  const response = await client.chat.completions.create({
    model: deployment,
    messages,
    tools,
    tool_choice: 'auto',
    temperature: 0.3,
    max_tokens: 4096
  });

  return { provider: 'Azure OpenAI', model: deployment, ...fromOpenAIResponse(response) };
}

async function callOpenAI(messages, tools) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key === 'your_openai_api_key_here') {
    throw Object.assign(new Error('OpenAI not configured'), { status: 401 });
  }

  const model = process.env.AI_MODEL || 'gpt-4o';
  const client = new OpenAI({ apiKey: key });

  const response = await client.chat.completions.create({
    model,
    messages,
    tools,
    tool_choice: 'auto',
    temperature: 0.3,
    max_tokens: 4096
  });

  return { provider: 'OpenAI', model, ...fromOpenAIResponse(response) };
}

async function callGitHub(messages, tools) {
  if (!process.env.GITHUB_TOKEN) {
    throw Object.assign(new Error('GitHub not configured'), { status: 401 });
  }

  const model = process.env.GITHUB_MODEL || 'gpt-4o';
  const client = new OpenAI({
    baseURL: 'https://models.inference.ai.azure.com',
    apiKey: process.env.GITHUB_TOKEN
  });

  const response = await client.chat.completions.create({
    model,
    messages,
    tools,
    tool_choice: 'auto',
    temperature: 0.3,
    max_tokens: 4096
  });

  return { provider: 'GitHub Models', model, ...fromOpenAIResponse(response) };
}

// ── Public API ────────────────────────────────────────────────────────────────

const PROVIDER_CHAIN = [
  { name: 'Anthropic', fn: callAnthropic },
  { name: 'Azure OpenAI', fn: callAzure },
  { name: 'OpenAI', fn: callOpenAI },
  { name: 'GitHub Models', fn: callGitHub }
];

async function callWithFallback(messages, tools) {
  let lastError;
  for (const provider of PROVIDER_CHAIN) {
    try {
      return await provider.fn(messages, tools);
    } catch (err) {
      if (isBlocked(err)) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('All providers failed or none are configured');
}

function getProviderStatus() {
  return {
    anthropic: !!(Anthropic && process.env.ANTHROPIC_API_KEY),
    azure: !!(process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT),
    openai: !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your_openai_api_key_here'),
    github: !!process.env.GITHUB_TOKEN
  };
}

function isAnyProviderReady() {
  const s = getProviderStatus();
  return s.anthropic || s.azure || s.openai || s.github;
}

function getActiveProviderName() {
  const s = getProviderStatus();
  if (s.anthropic) return 'Anthropic';
  if (s.azure) return 'Azure OpenAI';
  if (s.openai) return 'OpenAI';
  if (s.github) return 'GitHub Models';
  return null;
}

module.exports = { callWithFallback, getProviderStatus, isAnyProviderReady, getActiveProviderName };
