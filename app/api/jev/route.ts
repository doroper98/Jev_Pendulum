import { evaluateNetwork, validObservation } from '@/lib/jev';

const headers = { 'Cache-Control': 'no-store' };
export async function GET() {
  return Response.json({ configured: Boolean(process.env.TYPESAFE_API_KEY), model: process.env.JEV_MODEL || 'jev-latest' }, { headers });
}
export async function POST(request: Request) {
  // Same-origin browser calls only. No arbitrary proxy destination or prompt.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: '허용되지 않은 요청 출처입니다.' }, { status: 403, headers });
  if (Number(request.headers.get('content-length') || 0) > 16384) return Response.json({ error: '요청이 너무 큽니다.' }, { status: 413, headers });
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return Response.json({ error: '서버에 TYPESAFE_API_KEY를 설정한 뒤 다시 연결하세요.', code: 'KEY_REQUIRED' }, { status: 503, headers });
  try {
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: '상태값이 필요합니다.' }, { status: 400, headers });
    let size = 0, text = ''; const decoder = new TextDecoder();
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 16384) { await reader.cancel(); return Response.json({ error: '요청이 너무 큽니다.' }, { status: 413, headers }); } text += decoder.decode(value, { stream: true }); }
    text += decoder.decode();
    let body: unknown;
    try { body = JSON.parse(text); } catch { return Response.json({ error: '올바른 JSON이 필요합니다.' }, { status: 400, headers }); }
    if (!validObservation(body)) return Response.json({ error: '물리 상태와 실험 설정을 확인하세요.' }, { status: 400, headers });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(18000)]);
    const answer = await evaluateNetwork(body, process.env.JEV_MODEL || 'jev-latest', async evaluation => {
    const response = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(evaluation),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      const error = response.status === 401 ? 'Jev API 키가 유효하지 않습니다.' : response.status === 429 || response.status === 529 ? 'Jev 요청 한도 또는 일시적 혼잡으로 중단했습니다. 잠시 후 재개하세요.' : `Jev 서비스가 요청을 처리하지 못했습니다 (HTTP ${response.status}).`;
      throw new ProviderError(error, response.status === 429 ? 429 : 502);
    }
    // Tiny typed answers expected; bound external data before parsing.
    const upstream = response.body?.getReader();
    if (!upstream) throw new Error('empty response');
    let payload = '', bytes = 0; const utf8 = new TextDecoder();
    for (;;) { const part = await upstream.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 65536) { await upstream.cancel(); throw new Error('large response'); } payload += utf8.decode(part.value, { stream: true }); }
    payload += utf8.decode();
    return JSON.parse(payload);
    });
    return Response.json(answer, { headers });
  } catch (error) {
    if (error instanceof ProviderError) return Response.json({ error: error.message }, { status: error.status, headers });
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return Response.json({ error: timeout ? 'Jev 응답 대기 시간이 초과되었습니다. 실험을 일시정지했습니다.' : 'Jev 연결 또는 응답 검증에 실패했습니다. 실험을 일시정지했습니다.' }, { status: timeout ? 504 : 502, headers });
  }
}

class ProviderError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } }
