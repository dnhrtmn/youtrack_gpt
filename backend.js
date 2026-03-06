const http = require('@jetbrains/youtrack-scripting-api/http');

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function buildSystemPrompt() {
  return [
    'You answer questions using only provided YouTrack knowledge base context.',
    'Language: detect user language and answer in German or English accordingly.',
    'If context is insufficient, state that clearly and suggest refining the question.',
    'Always include source links in markdown format, e.g. [Article Title](https://...).',
    'Do not invent facts or links.'
  ].join(' ');
}

function safeRawResponse(response) {
  if (!response) {
    return '';
  }
  if (typeof response.response === 'string') {
    return response.response;
  }
  if (response.response === null || response.response === undefined) {
    return '';
  }
  return String(response.response);
}

function safeExceptionText(response) {
  if (!response || !response.exception) {
    return '';
  }
  const ex = response.exception;
  if (typeof ex.message === 'string' && ex.message) {
    return ex.message;
  }
  return String(ex);
}

function safeHeaders(response) {
  if (!response || !response.headers || !Array.isArray(response.headers)) {
    return [];
  }
  return response.headers.map((h) => ({ name: String(h.name), value: String(h.value) }));
}

function statusFromResponse(response) {
  if (!response) {
    return null;
  }
  if (typeof response.code === 'number') {
    return response.code;
  }
  if (typeof response.status === 'number') {
    return response.status;
  }
  if (typeof response.statusCode === 'number') {
    return response.statusCode;
  }
  return null;
}

function hasNetworkLikeFailure(response) {
  const status = statusFromResponse(response);
  const headers = safeHeaders(response);
  const details = safeRawResponse(response);
  const exceptionText = safeExceptionText(response);
  return status === null && headers.length === 0 && !details && !exceptionText;
}

function isAuthLikeStatus(status) {
  return status === 400 || status === 401 || status === 403 || status === 422;
}

function chooseBetterResponse(currentBest, candidate) {
  if (!candidate) {
    return currentBest;
  }
  if (!currentBest) {
    return candidate;
  }
  const bestStatus = statusFromResponse(currentBest);
  const candStatus = statusFromResponse(candidate);
  if (bestStatus === null && candStatus !== null) {
    return candidate;
  }
  return currentBest;
}

function parseSseOrJson(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    // Continue with SSE parsing fallback.
  }

  const lines = text.split(/\r?\n/);
  let acc = '';
  let lastJson = null;
  let sawData = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || !line.startsWith('data:')) {
      continue;
    }
    sawData = true;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') {
      continue;
    }

    let parsedChunk;
    try {
      parsedChunk = JSON.parse(payload);
    } catch (err) {
      continue;
    }
    lastJson = parsedChunk;

    const choice = parsedChunk && parsedChunk.choices && parsedChunk.choices[0];
    const delta = choice && choice.delta;
    const message = choice && choice.message;

    if (delta && typeof delta.content === 'string') {
      acc += delta.content;
    } else if (message && typeof message.content === 'string') {
      acc += message.content;
    }
  }

  if (acc) {
    return { choices: [{ message: { content: acc } }] };
  }
  if (lastJson) {
    return lastJson;
  }
  if (!sawData) {
    return null;
  }
  return { choices: [{ message: { content: '' } }] };
}

function buildSafeRequestPreview(payload) {
  try {
    return {
      model: payload && payload.model,
      stream: payload && payload.stream,
      temperature: payload && payload.temperature,
      messageCount: Array.isArray(payload && payload.messages) ? payload.messages.length : 0,
      userMessageLength:
        payload &&
        Array.isArray(payload.messages) &&
        payload.messages[1] &&
        typeof payload.messages[1].content === 'string'
          ? payload.messages[1].content.length
          : 0
    };
  } catch (err) {
    return { error: 'failed_to_build_preview' };
  }
}

exports.httpHandler = {
  endpoints: [
    {
      method: 'GET',
      path: 'config',
      permissions: ['READ_ARTICLE'],
      handle: function handleConfig(ctx) {
        const rawMax = Number(ctx.settings.maxArticles || 6);
        const maxArticles = Number.isFinite(rawMax) ? Math.min(Math.max(rawMax, 1), 20) : 6;
        ctx.response.json({ maxArticles: maxArticles });
      }
    },
    {
      method: 'POST',
      path: 'ask',
      permissions: ['READ_ARTICLE'],
      handle: function handleAsk(ctx) {
        const body = ctx.request.json() || {};
        const question = String(body.question || '').trim();
        const sources = Array.isArray(body.sources) ? body.sources : [];
        const debugMode = Boolean(body.debug);

        if (!question) {
          ctx.response.status = 400;
          ctx.response.json({ error: 'question is required' });
          return;
        }

        const baseUrl = normalizeBaseUrl(ctx.settings.litellmBaseUrl);
        const model = String(ctx.settings.litellmModel || '').trim();
        const apiKey = ctx.settings.litellmApiKey;

        if (!baseUrl || !model || !apiKey) {
          ctx.response.status = 500;
          ctx.response.json({
            error: 'App settings are incomplete. Please configure LiteLLM URL, model, and API key.'
          });
          return;
        }

        const contextBlock = sources
          .map((s, i) => {
            const title = String(s.title || 'Untitled');
            const url = String(s.url || '');
            const text = String(s.excerpt || '');
            return `Source ${i + 1}: ${title}\nURL: ${url}\nContent:\n${text}`;
          })
          .join('\n\n-----\n\n');

        const payload = {
          model,
          stream: false,
          temperature: 0.1,
          messages: [
            { role: 'system', content: buildSystemPrompt() },
            {
              role: 'user',
              content: [
                `Question: ${question}`,
                '',
                'Knowledge Base Context:',
                contextBlock || 'No context was provided.'
              ].join('\n')
            }
          ]
        };

        const connection = new http.Connection(baseUrl, null, 10000);
        connection.addHeader('Content-Type', 'application/json');
        connection.addHeader('Accept', 'application/json');
        connection.bearerAuth(apiKey);

        const triedPaths = ['v1/chat/completions', '/v1/chat/completions', 'chat/completions', '/chat/completions'];
        let response = null;
        let bestResponse = null;
        let bestResponsePath = null;
        let lastThrown = null;

        let usedPath = null;
        for (let i = 0; i < triedPaths.length; i += 1) {
          const path = triedPaths[i];
          try {
            response = connection.postSync(path, [], payload);
            if (response && response.isSuccess === true) {
              usedPath = path;
              break;
            }

            const chosen = chooseBetterResponse(bestResponse, response);
            if (chosen !== bestResponse) {
              bestResponse = chosen;
              bestResponsePath = path;
            }
            const status = statusFromResponse(response);
            if (isAuthLikeStatus(status)) {
              usedPath = path;
              break;
            }
          } catch (err) {
            lastThrown = err;
          }
        }

        if ((!response || response.isSuccess !== true) && bestResponse) {
          response = bestResponse;
          if (!usedPath) {
            usedPath = bestResponsePath;
          }
        }

        if (!response && lastThrown) {
          ctx.response.status = 502;
          ctx.response.json({ error: `LiteLLM request failed: ${String(lastThrown && lastThrown.message ? lastThrown.message : lastThrown)}` });
          return;
        }

        if (!response) {
          ctx.response.status = 502;
          ctx.response.json({
            error: 'LiteLLM returned no response object.',
            baseUrl: baseUrl,
            triedPaths: triedPaths,
            requestPreview: buildSafeRequestPreview(payload)
          });
          return;
        }

        const exceptionText = safeExceptionText(response);
        if (exceptionText) {
          ctx.response.status = 502;
          ctx.response.json({
            error: 'LiteLLM connection failed before receiving a response payload.',
            exception: exceptionText,
            status: statusFromResponse(response),
            isSuccess: response.isSuccess,
            headers: safeHeaders(response),
            baseUrl: baseUrl,
            triedPaths: triedPaths,
            requestPreview: buildSafeRequestPreview(payload)
          });
          return;
        }

        if (response.isSuccess !== true) {
          const networkHint = hasNetworkLikeFailure(response)
            ? 'Connection from YouTrack to LiteLLM failed. Do not use localhost unless LiteLLM runs in the same network namespace as YouTrack. Use a reachable host/IP/service name and open port 4000.'
            : null;
          ctx.response.status = 502;
          ctx.response.json({
            error: 'LiteLLM returned a non-success status.',
            status: statusFromResponse(response),
            isSuccess: response.isSuccess,
            headers: safeHeaders(response),
            details: safeRawResponse(response),
            baseUrl: baseUrl,
            triedPaths: triedPaths,
            hint: networkHint,
            requestPreview: buildSafeRequestPreview(payload)
          });
          return;
        }

        let parsed = null;
        try {
          parsed = response.json();
        } catch (err) {
          parsed = null;
        }

        if (!parsed) {
          parsed = parseSseOrJson(safeRawResponse(response));
        }

        if (!parsed) {
          const raw = safeRawResponse(response);
          ctx.response.status = 502;
          ctx.response.json({
            error: 'Failed to parse LiteLLM response payload.',
            status: statusFromResponse(response),
            responsePreview: String(raw || '').slice(0, 1200),
            requestPreview: buildSafeRequestPreview(payload)
          });
          return;
        }

        const answer =
          parsed &&
          parsed.choices &&
          parsed.choices[0] &&
          parsed.choices[0].message &&
          parsed.choices[0].message.content
            ? String(parsed.choices[0].message.content)
            : '';

        if (!answer) {
          ctx.response.status = 502;
          ctx.response.json({ error: 'LiteLLM returned an empty answer.' });
          return;
        }

        const result = { answer: answer };
        if (debugMode) {
          result.debug = {
            baseUrl: baseUrl,
            usedPath: usedPath,
            triedPaths: triedPaths,
            status: statusFromResponse(response),
            isSuccess: response && response.isSuccess,
            headers: safeHeaders(response),
            requestPreview: buildSafeRequestPreview(payload)
          };
        }

        ctx.response.json(result);
      }
    }
  ]
};
