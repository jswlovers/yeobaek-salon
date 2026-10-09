// 카카오 알림톡 발송 (Solapi 경유). 키·템플릿이 없으면 mock(로그만 출력)으로 동작해 예약 흐름에 영향이 없다.
// 필요 환경변수: SOLAPI_API_KEY, SOLAPI_API_SECRET, SOLAPI_SENDER, KAKAO_PF_ID,
//               KAKAO_TEMPLATE_RECEIVED / _CONFIRMED / _CANCELLED / _REMINDER (종류별 승인된 템플릿 ID)
const crypto = require('crypto');

const TEMPLATE_ENV = {
  received: 'KAKAO_TEMPLATE_RECEIVED',   // 예약 접수
  confirmed: 'KAKAO_TEMPLATE_CONFIRMED', // 예약 확정
  cancelled: 'KAKAO_TEMPLATE_CANCELLED', // 예약 취소
  reminder: 'KAKAO_TEMPLATE_REMINDER',   // 방문 전 안내
};
const KINDS = Object.keys(TEMPLATE_ENV);

const won = n => Number(n || 0).toLocaleString('ko-KR');
const when = r => `${r.date} ${r.time}`;
const HEAD = {
  received: r => `[여백 미장원] ${r.name}님, 예약이 접수되었습니다.`,
  confirmed: r => `[여백 미장원] ${r.name}님, 예약이 확정되었습니다.`,
  cancelled: r => `[여백 미장원] ${r.name}님, 예약이 취소되었습니다.`,
  reminder: r => `[여백 미장원] ${r.name}님, 방문 일정을 안내드립니다.`,
};
// 알림톡 템플릿 본문과 SMS 대체 문구로 함께 쓰인다 (docs 의 템플릿 예시와 동일한 변수)
const text = (kind, r) => [
  HEAD[kind](r),
  `일시: ${when(r)}`,
  `시술: ${r.service}${r.designer && r.designer !== '지정 없음' ? ` (${r.designer})` : ''}`,
  `현장 결제 예정: ${won(Number(r.price || 0) - Number(r.coinUsed || 0))}원`,
  '문의: 031-123-4567',
].join('\n');

const variables = r => ({
  '#{이름}': r.name,
  '#{일시}': when(r),
  '#{시술}': r.service,
  '#{담당}': r.designer || '지정 없음',
  '#{결제금액}': won(Number(r.price || 0) - Number(r.coinUsed || 0)),
});

async function sendKakao(kind, r) {
  const { SOLAPI_API_KEY: apiKey, SOLAPI_API_SECRET: secret, SOLAPI_SENDER: sender, KAKAO_PF_ID: pfId } = process.env;
  const templateId = process.env[TEMPLATE_ENV[kind]];
  const to = String(r.phone).replace(/\D/g, '');
  const body = text(kind, r);

  if (!apiKey || !secret || !sender || !pfId || !templateId) {
    console.log(`[Kakao mock] ${kind} -> ${to}\n${body}`);
    return { ok: true, mocked: true };
  }
  const date = new Date().toISOString(), salt = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', secret).update(date + salt).digest('hex');
  try {
    const res = await fetch('https://api.solapi.com/messages/v4/send', {
      method: 'POST',
      headers: { Authorization: `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`, 'Content-Type': 'application/json' },
      // disableSms:false → 알림톡 실패 시 문자로 자동 대체 발송
      body: JSON.stringify({ message: { to, from: sender, text: body, kakaoOptions: { pfId, templateId, variables: variables(r), disableSms: false } } }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) { console.error('[Kakao] 발송 실패', res.status, JSON.stringify(j)); return { ok: false, mocked: false }; }
    return { ok: true, mocked: false };
  } catch (e) {
    console.error('[Kakao] 요청 오류', e.message);
    return { ok: false, mocked: false };
  }
}

module.exports = { sendKakao, KINDS };
