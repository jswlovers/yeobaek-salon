// 여백 미장원: 정적 파일 서버 + 네이버 캘린더 연동 (Node 18+, 의존성 없음)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendKakao, KINDS } = require('./kakao');

// .env 파일이 있으면 process.env에 반영 (dotenv 의존성 없이 직접 파싱)
const ENV_PATH = path.join(__dirname, '.env');
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = (m[2] || '').trim();
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

const {
  NAVER_CLIENT_ID,
  NAVER_CLIENT_SECRET,
  ADMIN_KEY,
  SSL_CERT_PATH,
  SSL_KEY_PATH,
  PORT = 3000,
  PUBLIC_URL = `http://localhost:${PORT}`,
} = process.env;

if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET || !ADMIN_KEY) {
  console.error('환경변수 NAVER_CLIENT_ID, NAVER_CLIENT_SECRET, ADMIN_KEY 를 설정해주세요. (README 참고)');
  process.exit(1);
}

const REDIRECT_URI = `${PUBLIC_URL}/auth/naver/callback`;
const STORE = path.join(__dirname, 'naver-store.json'); // 토큰 + 등록 완료된 예약 id
const STATIC = new Set(['/index.html', '/app.js', '/styles.css', '/terms.html', '/privacy.html', '/policy.html']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const load = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return { token: null, synced: {} }; } };
const store = load();
store.notified ||= {}; // 카카오 알림 발송 이력 (중복 발송 방지)
store.reservations ||= {};
store.consents ||= []; // 개인정보·약관 동의 이력 (추가만 하고 덮어쓰지 않음, 3년 후 삭제) — docs/booking-screen-spec.md // 방문 전날 자동 안내용: 서버로 전달된 예약 사본 { id: {..., confirmed, cancelled} }
const KEEP = ['id', 'date', 'time', 'name', 'phone', 'service', 'designer', 'price', 'coinUsed'];
const remember = r => { store.reservations[r.id] ||= Object.fromEntries(KEEP.map(k => [k, r[k]])); return store.reservations[r.id]; };
const persist = () => fs.writeFileSync(STORE, JSON.stringify(store, null, 2), { mode: 0o600 });

const states = new Map(); // OAuth state → 만료시각
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function tokenRequest(params) {
  const url = new URL('https://nid.naver.com/oauth2.0/token');
  url.search = new URLSearchParams({ client_id: NAVER_CLIENT_ID, client_secret: NAVER_CLIENT_SECRET, ...params });
  const j = await (await fetch(url)).json();
  if (j.error) throw new Error(`${j.error}: ${j.error_description}`);
  return j;
}

async function accessToken() {
  const t = store.token;
  if (!t) throw new Error('네이버 캘린더가 연동되지 않았습니다. 관리자 화면에서 연동해주세요.');
  if (Date.now() < t.expiresAt - 60_000) return t.access_token;
  const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  store.token = { ...t, access_token: j.access_token, expiresAt: Date.now() + Number(j.expires_in) * 1000 };
  persist();
  return store.token.access_token;
}

const pad = n => String(n).padStart(2, '0');
const icsText = s => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, m => '\\' + m);
const stamp = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const local = (date, time, addMin = 0) => {
  const [y, mo, d] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number);
  const x = new Date(Date.UTC(y, mo - 1, d, h, mi + addMin));
  return `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1)}${pad(x.getUTCDate())}T${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}00`;
};

function buildIcs(r) {
  const now = stamp(new Date());
  const desc = [`연락처: ${r.phone}`, `담당: ${r.designer || '-'}`, `시술 금액: ${Number(r.price || 0).toLocaleString('ko-KR')}원`, `코인 사용: ${Number(r.coinUsed || 0).toLocaleString('ko-KR')} C`].join('\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:Yeobaek Salon', 'CALSCALE:GREGORIAN',
    'BEGIN:VTIMEZONE', 'TZID:Asia/Seoul', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZNAME:GMT+09:00', 'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'SEQUENCE:0', 'CLASS:PUBLIC', 'TRANSP:OPAQUE',
    `UID:yeobaek-${r.id}@salon`,
    `DTSTART;TZID=Asia/Seoul:${local(r.date, r.time)}`,
    `DTEND;TZID=Asia/Seoul:${local(r.date, r.time, 60)}`,
    `SUMMARY:${icsText(`[예약] ${r.name} · ${r.service}`)}`,
    `DESCRIPTION:${icsText(desc)}`,
    `CREATED:${now}`, `LAST-MODIFIED:${now}`, `DTSTAMP:${now}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

async function createSchedule(r) {
  const res = await fetch('https://openapi.naver.com/calendar/createSchedule.json', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ calendarId: 'defaultCalendarId', scheduleIcalString: buildIcs(r) }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.result === 'fail') throw new Error(`네이버 캘린더 등록 실패 (${res.status}) ${JSON.stringify(j)}`);
}

const valid = r => r && Number.isFinite(Number(r.id)) && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && /^\d{2}:\d{2}$/.test(r.time)
  && ['name', 'phone', 'service'].every(k => typeof r[k] === 'string' && r[k].length > 0 && r[k].length <= 100);

// 예약 신청 시 받은 동의를 항목별로 기록. 필수 항목이 빠지면 false
const CONSENT_ITEMS = ['age14', 'terms', 'privacy'];
const CONSENT_KEEP_MS = 3 * 365 * 24 * 60 * 60_000;
function recordConsent(req, r) {
  const c = r.consent;
  if (!c || typeof c.version !== 'string' || !Array.isArray(c.items) || !CONSENT_ITEMS.every(k => c.items.includes(k))) return false;
  if (store.consents.some(x => x.reservation_id === r.id)) return true;
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  const at = Date.parse(c.agreedAt) ? new Date(c.agreedAt).toISOString() : null;
  for (const type of CONSENT_ITEMS) store.consents.push({
    reservation_id: r.id, phone: String(r.phone).replace(/\D/g, ''), consent_type: type, agreed: true,
    agreed_at: at, recorded_at: new Date().toISOString(), document_version: c.version.slice(0, 20),
    ip_address: ip, user_agent: String(req.headers['user-agent'] || '').slice(0, 200), channel: 'booking',
  });
  return true;
}

const readBody = req => new Promise((resolve, reject) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 10_000) { reject(new Error('too large')); req.destroy(); } });
  req.on('end', () => resolve(b));
});
const send = (res, code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };

const handler = async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  try {
    // 관리자: 네이버 로그인 시작 (원장님 계정으로 1회 연동)
    if (url.pathname === '/auth/naver/login') {
      if (!safeEq(url.searchParams.get('key') || '', ADMIN_KEY)) return send(res, 403, '관리자 키가 올바르지 않습니다.', 'text/plain; charset=utf-8');
      const state = crypto.randomBytes(16).toString('hex');
      states.set(state, Date.now() + 10 * 60_000);
      const a = new URL('https://nid.naver.com/oauth2.0/authorize');
      a.search = new URLSearchParams({ response_type: 'code', client_id: NAVER_CLIENT_ID, redirect_uri: REDIRECT_URI, state });
      res.writeHead(302, { Location: a.toString() }); return res.end();
    }
    if (url.pathname === '/auth/naver/callback') {
      const state = url.searchParams.get('state');
      if (!states.has(state) || states.get(state) < Date.now()) return send(res, 400, '잘못되었거나 만료된 요청입니다.', 'text/plain; charset=utf-8');
      states.delete(state);
      const j = await tokenRequest({ grant_type: 'authorization_code', code: url.searchParams.get('code'), state });
      store.token = { access_token: j.access_token, refresh_token: j.refresh_token, expiresAt: Date.now() + Number(j.expires_in) * 1000 };
      persist();
      return send(res, 200, '<meta charset="utf-8"><p>네이버 캘린더 연동이 완료되었습니다.</p><a href="/">돌아가기</a>', 'text/html; charset=utf-8');
    }
    if (url.pathname === '/auth/naver/disconnect' && req.method === 'POST') {
      if (!safeEq(url.searchParams.get('key') || '', ADMIN_KEY)) return send(res, 403, { error: 'forbidden' });
      if (store.token) {
        try { await tokenRequest({ grant_type: 'delete', access_token: await accessToken(), service_provider: 'NAVER' }); }
        catch (e) { console.error('토큰 폐기 실패(로컬 연동은 해제됨):', e.message); }
        store.token = null; persist();
      }
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/calendar/status') return send(res, 200, { connected: !!store.token });

    // 관리자 로그인: 관리자 화면 접근 시 비밀번호(=ADMIN_KEY) 확인
    if (url.pathname === '/api/admin/login' && req.method === 'POST') {
      const { key } = JSON.parse(await readBody(req));
      if (!safeEq(key || '', ADMIN_KEY)) return send(res, 403, { ok: false });
      return send(res, 200, { ok: true });
    }

    // 고객 예약 → 원장님 네이버 캘린더 등록
    if (url.pathname === '/api/reservations' && req.method === 'POST') {
      const r = JSON.parse(await readBody(req));
      if (!valid(r)) return send(res, 400, { error: 'invalid reservation' });
      if (!recordConsent(req, r)) return send(res, 400, { error: 'consent required' });
      // 카카오 알림톡(접수 안내): 캘린더 등록 성공 여부와 무관하게, 예약당 1회만 발송
      remember(r); persist();
      if (!store.notified[`received:${r.id}`]) {
        const k = await sendKakao('received', r);
        if (k.ok) { store.notified[`received:${r.id}`] = Date.now(); persist(); }
      }
      if (store.synced[r.id]) return send(res, 200, { ok: true, duplicate: true });
      await createSchedule(r);
      store.synced[r.id] = Date.now(); persist();
      return send(res, 200, { ok: true });
    }

    // 관리자: 고객에게 카카오 알림톡 발송 (확정·취소·방문 안내)
    if (url.pathname === '/api/notify' && req.method === 'POST') {
      if (!safeEq(url.searchParams.get('key') || '', ADMIN_KEY)) return send(res, 403, { error: 'forbidden' });
      const { kind, reservation: r } = JSON.parse(await readBody(req));
      if (!KINDS.includes(kind) || !valid(r)) return send(res, 400, { error: 'invalid request' });
      const k = await sendKakao(kind, r);
      if (k.ok && (kind === 'confirmed' || kind === 'cancelled')) { // 자동 방문 안내 대상 여부 갱신
        remember(r)[kind === 'confirmed' ? 'confirmed' : 'cancelled'] = true; persist();
      }
      return send(res, k.ok ? 200 : 502, { ok: k.ok, mocked: !!k.mocked });
    }

    // 관리자가 예약을 삭제하면 자동 방문 안내 대상에서도 제외
    if (url.pathname === '/api/reservations/remove' && req.method === 'POST') {
      if (!safeEq(url.searchParams.get('key') || '', ADMIN_KEY)) return send(res, 403, { error: 'forbidden' });
      const { id } = JSON.parse(await readBody(req));
      delete store.reservations[id]; persist();
      return send(res, 200, { ok: true });
    }

    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    if (STATIC.has(p)) return send(res, 200, fs.readFileSync(path.join(__dirname, p)), TYPES[path.extname(p)]);
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  } catch (e) {
    console.error(e.message);
    send(res, 500, { error: '서버 오류' });
  }
};

// 방문 전날 자동 안내: 확정(확정 안내를 보낸)·미취소 예약에 대해 REMINDER_HOUR시(기본 10시) 이후 1회 발송
const REMINDER_HOUR = Number(process.env.REMINDER_HOUR ?? 10);
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
async function sendReminders() {
  const now = new Date();
  if (now.getHours() < REMINDER_HOUR) return;
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const cutoff = new Date(now); cutoff.setDate(now.getDate() - 30);
  for (const [id, r] of Object.entries(store.reservations)) {
    if (r.date < ymd(cutoff)) { delete store.reservations[id]; delete store.notified[`reminder:${id}`]; delete store.notified[`received:${id}`]; continue; } // 30일 지난 기록 정리
    if (r.date !== ymd(tomorrow) || !r.confirmed || r.cancelled || store.notified[`reminder:${id}`]) continue;
    const k = await sendKakao('reminder', r);
    if (k.ok) store.notified[`reminder:${id}`] = Date.now();
  }
  const expired = Date.now() - CONSENT_KEEP_MS; // 보유 기간(3년) 지난 동의 이력 삭제
  store.consents = store.consents.filter(x => Date.parse(x.recorded_at) > expired);
  persist();
}
sendReminders().catch(e => console.error('방문 안내 오류:', e.message));
setInterval(() => sendReminders().catch(e => console.error('방문 안내 오류:', e.message)), 30 * 60_000).unref();

// SSL_CERT_PATH/SSL_KEY_PATH 를 주면 HTTPS(예: *.sean2022.one 와일드카드 인증서)로 실행
const server = SSL_CERT_PATH && SSL_KEY_PATH
  ? https.createServer({ cert: fs.readFileSync(SSL_CERT_PATH), key: fs.readFileSync(SSL_KEY_PATH) }, handler)
  : http.createServer(handler);
// 인증서 파일이 바뀌면 재시작 없이 새 인증서를 적용한다(1시간마다 확인). 포레스트클럽의 Porkbun 인증서
// (D:/github/포레스트클럽/certs/porkbun-sean2022.one-*.pem)를 가리키면 작업 스케줄러가 매일 갱신해 준다.
if (SSL_CERT_PATH && SSL_KEY_PATH) {
  let loadedCert = fs.readFileSync(SSL_CERT_PATH);
  setInterval(() => {
    try {
      const cert = fs.readFileSync(SSL_CERT_PATH);
      if (cert.equals(loadedCert)) return;
      server.setSecureContext({ cert, key: fs.readFileSync(SSL_KEY_PATH) });
      loadedCert = cert;
      console.log('새 인증서를 재시작 없이 적용했어요');
    } catch (e) {
      console.error('새 인증서 적용 실패 (기존 인증서로 계속 서비스):', e.message);
    }
  }, 60 * 60_000).unref();
}
server.listen(PORT, () => console.log(`${SSL_CERT_PATH ? 'https' : 'http'}://localhost:${PORT}`));
