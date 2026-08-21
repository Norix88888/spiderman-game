/* =========================================================================
   body2.js — 후보2: 암시적 표면(메타볼/SDF) 기반 연속 인체 SkinnedMesh
   ---------------------------------------------------------------------
   접근:
     1) 인체를 40여개의 "라운드 콘(양끝 반지름이 다른 캡슐)" 거리장으로 정의한다.
     2) 같은 부위끼리는 넉넉한 smooth-min(k=0.06), 다른 부위끼리는 좁은
        smooth-min(k=0.03) 으로 합쳐서 어깨/골반 이음매를 "녹여" 붙인다.
     3) 마칭큐브 대신 원통 좌표계 스위핑: 축(척추/팔/다리)을 따라 링을 놓고,
        링 중심에서 바깥으로 이분탐색 레이캐스트를 쏴 등가면(SDF=0)을 찾는다.
        → 격자 해상도 걱정 없이 정점 2천개로 매끈한 표면을 얻는다.
   THREE r128 UMD 전역, ES 모듈 금지.
   ========================================================================= */
(function () {
  'use strict';
  const NS = (window.SPIDER = window.SPIDER || {});

  /* ---------------------------------------------------------------- 수학 */

  /* 다항식 스무스 민: 두 표면이 k 안쪽으로 가까워지면 서로 녹아 붙는다 */
  function smin(a, b, k) {
    const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
    return b + (a - b) * h - k * h * (1 - h);
  }

  /* IQ 라운드 콘 SDF (정확식). a,b 는 스케일 공간 좌표 */
  function roundCone(px, py, pz, P) {
    const bax = P.bx - P.ax, bay = P.by - P.ay, baz = P.bz - P.az;
    const l2 = P.l2, rr = P.r1 - P.r2, a2 = P.a2, il2 = P.il2;
    const pax = px - P.ax, pay = py - P.ay, paz = pz - P.az;
    const y = pax * bax + pay * bay + paz * baz;
    const z = y - l2;
    const cx = pax * l2 - bax * y, cy = pay * l2 - bay * y, cz = paz * l2 - baz * y;
    const x2 = cx * cx + cy * cy + cz * cz;
    const y2 = y * y * l2, z2 = z * z * l2;
    const k = (rr < 0 ? -1 : rr > 0 ? 1 : 0) * rr * rr * x2;
    if ((z < 0 ? -1 : 1) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - P.r2;
    if ((y < 0 ? -1 : 1) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - P.r1;
    return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - P.r1;
  }

  /* --------------------------------------------------------- 프리미티브 */
  /* 월드 A,B,반지름 과 축별 스케일(눌림)로 라운드 콘을 만든다.
     스케일 공간(=p/s)에서 거리계산 후 min(s) 를 곱해 근사 거리로 되돌린다. */
  function prim(g, A, B, r1, r2, s) {
    s = s || [1, 1, 1];
    const P = {
      g: g, sx: s[0], sy: s[1], sz: s[2],
      ix: 1 / s[0], iy: 1 / s[1], iz: 1 / s[2],
      ax: A[0] / s[0], ay: A[1] / s[1], az: A[2] / s[2],
      bx: B[0] / s[0], by: B[1] / s[1], bz: B[2] / s[2],
      r1: r1, r2: r2 == null ? r1 : r2
    };
    const bax = P.bx - P.ax, bay = P.by - P.ay, baz = P.bz - P.az;
    P.l2 = Math.max(1e-9, bax * bax + bay * bay + baz * baz);
    P.il2 = 1 / P.l2;
    const rr = P.r1 - P.r2;
    P.a2 = Math.max(1e-9, P.l2 - rr * rr);
    /* 스케일 공간 거리를 월드로 되돌릴 때 min(s) 를 곱하는 게 보수적(립시츠)이지만,
       그러면 기울기가 1보다 작아져서 smooth-min 오프셋이 실제 표면을 크게 부풀린다.
       여기서는 스피어트레이싱이 아니라 선형스캔+이분탐색이라 보정이 필요없다. */
    P.ms = 1;
    /* 월드 바운딩 스피어 (레이마칭 컬링용) */
    const mx = Math.max(s[0], Math.max(s[1], s[2]));
    P.cx = (A[0] + B[0]) * 0.5; P.cy = (A[1] + B[1]) * 0.5; P.cz = (A[2] + B[2]) * 0.5;
    const hx = (A[0] - B[0]) * 0.5, hy = (A[1] - B[1]) * 0.5, hz = (A[2] - B[2]) * 0.5;
    P.br = Math.sqrt(hx * hx + hy * hy + hz * hz) + Math.max(P.r1, P.r2) * mx;
    return P;
  }

  /* smin 은 한 번 합칠 때마다 표면을 최대 k/4 만큼 바깥으로 부풀린다.
     여러 프리미티브가 누적되므로 k 는 작게 잡고, 대신 근육 덩어리를 겹쳐 놓는다. */
  const K_IN = 0.034;   // 같은 부위 내 블렌드 (근육 덩어리끼리 뭉개기)
  const K_OUT = 0.022;  // 부위 간 블렌드 (어깨/사타구니 필렛)
  const NG = 5;         // 0=몸통/머리 1=팔L 2=팔R 3=다리L 4=다리R
  const _rg = new Float64Array(NG);

  /* 최종 거리장: 부위별로 모은 뒤 부위끼리 좁게 블렌드 */
  function field(px, py, pz, list) {
    for (let i = 0; i < NG; i++) _rg[i] = 1e9;
    for (let i = 0; i < list.length; i++) {
      const P = list[i];
      const d = roundCone(px * P.ix, py * P.iy, pz * P.iz, P) * P.ms;
      const g = P.g;
      _rg[g] = _rg[g] > 1e8 ? d : smin(_rg[g], d, K_IN);
    }
    let r = 1e9;
    for (let i = 0; i < NG; i++) {
      if (_rg[i] > 1e8) continue;
      r = r > 1e8 ? _rg[i] : smin(r, _rg[i], K_OUT);
    }
    return r;
  }

  /* ------------------------------------------------------------ 해부 정의 */
  /* 총키 1.85m, 7.5등신. rz<rx (앞뒤로 눌린 몸통), 팔은 살짝 벌어져
     차렷 자세에서 옆구리와 융합되지 않게 한다(팔꿈치 x .215, 손목 x .232). */
  function anatomy() {
    const L = [];
    /* --- 몸통/머리 (region 0) --- */
    /* 골반: 아래쪽 구형 캡이 사타구니를 통째로 메우지 않게 y 를 눌러 y0.855 에서 끝냄 */
    L.push(prim(0, [0, 0.930, -0.008], [0, 1.015, 0], 0.158, 0.144, [1, 0.48, 0.76]));
    L.push(prim(0, [0, 1.015, 0], [0, 1.115, 0], 0.142, 0.117, [1, 1, 0.76]));      // 허리(최협)
    L.push(prim(0, [0, 1.115, 0], [0, 1.335, 0.004], 0.121, 0.168, [1, 1, 0.60]));  // 흉곽
    /* 상흉부: 위쪽 캡이 구로 부풀어 목을 삼키지 않게 y 스케일로 눌러둔다 */
    L.push(prim(0, [0, 1.335, 0.004], [0, 1.398, -0.008], 0.168, 0.122, [1, 0.72, 0.62]));
    L.push(prim(0, [0.074, 1.316, 0.048], [0.074, 1.350, 0.043], 0.070, 0.060, [1, 1, 0.52])); // 대흉근L
    L.push(prim(0, [-0.074, 1.316, 0.048], [-0.074, 1.350, 0.043], 0.070, 0.060, [1, 1, 0.52]));
    L.push(prim(0, [0, 1.400, -0.012], [0, 1.548, -0.006], 0.068, 0.060, [1, 1, 0.95]));  // 목
    /* 승모근 능선: 목뿌리(1.51) → 어깨끝(1.47) 으로 완만히 내려가는 경사.
       이 경사가 있어야 수평 링 스위핑이 어깨 윗면을 매끄럽게 잡아낸다 */
    L.push(prim(0, [0, 1.468, -0.022], [0.166, 1.418, -0.006], 0.044, 0.058, [1, 0.80, 1.10]));
    L.push(prim(0, [0, 1.468, -0.022], [-0.166, 1.418, -0.006], 0.044, 0.058, [1, 0.80, 1.10]));
    L.push(prim(0, [0.196, 1.392, 0], [0.199, 1.356, 0], 0.086, 0.082, [1, 1.0, 0.92])); // 삼각근L
    L.push(prim(0, [-0.196, 1.392, 0], [-0.199, 1.356, 0], 0.086, 0.082, [1, 1.0, 0.92]));
    /* 머리: 두개골(뒤통수 볼록) + 턱 + 광대 + 코 + 눈두덩 */
    L.push(prim(0, [0, 1.712, -0.016], [0, 1.716, -0.020], 0.135, 0.135, [0.565, 1, 0.720]));
    L.push(prim(0, [0, 1.662, 0.014], [0, 1.688, 0.018], 0.097, 0.097, [0.80, 0.70, 1.02])); // 턱선
    L.push(prim(0, [0.063, 1.688, 0.052], [0.040, 1.694, 0.062], 0.040, 0.034));  // 광대L
    L.push(prim(0, [-0.063, 1.688, 0.052], [-0.040, 1.694, 0.062], 0.040, 0.034));
    L.push(prim(0, [0, 1.700, 0.078], [0, 1.672, 0.092], 0.024, 0.020, [0.85, 1, 1])); // 코 융기
    L.push(prim(0, [-0.062, 1.727, 0.070], [0.062, 1.727, 0.070], 0.029, 0.029, [1, 0.72, 0.85])); // 눈썹뼈

    /* --- 팔 / 다리 (좌우 미러) --- */
    for (let si = 0; si < 2; si++) {
      const s = si === 0 ? 1 : -1;          // +1 = 캐릭터 왼쪽(+X)
      const ga = si === 0 ? 1 : 2, gl = si === 0 ? 3 : 4;
      const X = v => s * v;
      /* 상완 → 팔꿈치 → 전완 → 손 */
      L.push(prim(ga, [X(0.198), 1.412, 0], [X(0.215), 1.140, 0], 0.076, 0.049));
      L.push(prim(ga, [X(0.206), 1.330, 0.020], [X(0.211), 1.255, 0.016], 0.056, 0.052)); // 이두박근
      L.push(prim(ga, [X(0.204), 1.340, -0.024], [X(0.212), 1.235, -0.018], 0.048, 0.045)); // 삼두
      L.push(prim(ga, [X(0.215), 1.140, 0], [X(0.216), 1.122, 0], 0.048, 0.047));  // 팔꿈치(가늘게)
      L.push(prim(ga, [X(0.218), 1.122, 0], [X(0.232), 0.868, 0], 0.050, 0.033));  // 전완
      L.push(prim(ga, [X(0.222), 1.070, 0.004], [X(0.225), 1.020, 0.004], 0.053, 0.049)); // 전완 근복
      L.push(prim(ga, [X(0.233), 0.858, 0.002], [X(0.235), 0.782, 0.006], 0.047, 0.048, [0.95, 1, 0.56])); // 손바닥
      L.push(prim(ga, [X(0.235), 0.782, 0.008], [X(0.236), 0.716, 0.012], 0.046, 0.042, [0.95, 1, 0.52])); // 네 손가락
      L.push(prim(ga, [X(0.219), 0.812, 0.026], [X(0.212), 0.762, 0.060], 0.022, 0.018)); // 엄지
      /* 둔부 → 허벅지 → 무릎 → 종아리 → 발 */
      L.push(prim(gl, [X(0.092), 0.952, -0.042], [X(0.098), 0.930, -0.030], 0.086, 0.082, [1, 0.95, 0.86])); // 둔근
      L.push(prim(gl, [X(0.105), 0.948, 0], [X(0.105), 0.505, 0], 0.101, 0.066));
      L.push(prim(gl, [X(0.106), 0.760, 0.020], [X(0.106), 0.640, 0.016], 0.090, 0.084, [1, 1, 0.94])); // 대퇴사두
      L.push(prim(gl, [X(0.105), 0.500, 0.008], [X(0.105), 0.470, 0.004], 0.066, 0.064, [1, 0.92, 1])); // 무릎
      L.push(prim(gl, [X(0.105), 0.470, 0], [X(0.105), 0.072, 0.004], 0.064, 0.038));
      L.push(prim(gl, [X(0.105), 0.400, -0.024], [X(0.105), 0.330, -0.018], 0.062, 0.056, [1, 1, 0.95])); // 종아리
      L.push(prim(gl, [X(0.105), 0.058, -0.048], [X(0.105), 0.050, -0.030], 0.050, 0.048, [0.92, 0.90, 1])); // 뒤꿈치
      L.push(prim(gl, [X(0.105), 0.042, -0.035], [X(0.104), 0.040, 0.122], 0.054, 0.052, [0.90, 0.75, 1])); // 발/신발
    }
    return L;
  }

  /* 링 근처 프리미티브만 추리기 (레이마칭 비용 절감) */
  function cull(list, cx, cy, cz, reach) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const P = list[i];
      const dx = P.cx - cx, dy = P.cy - cy, dz = P.cz - cz;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) < P.br + reach) out.push(P);
    }
    return out;
  }

  /* 링 중심에서 방향 D 로 등가면(SDF=0) 탐색.
     안쪽→바깥 선형 스캔으로 "첫 번째" 부호변화 구간을 찾은 뒤 이분탐색한다.
     (곧장 이분탐색하면 팔·몸통처럼 표면이 여러 번 교차할 때 먼 표면으로 튄다) */
  const SCAN = 22;
  function march(list, cx, cy, cz, dx, dz, rMin, rMax) {
    let lo = -1, hi = rMax, prev = field(cx, cy, cz, list);
    if (prev > 0) return rMin;                     // 중심이 바깥 → 폴백
    for (let i = 1; i <= SCAN; i++) {
      const t = rMax * (i / SCAN);
      const d = field(cx + dx * t, cy, cz + dz * t, list);
      if (d >= 0) { lo = rMax * ((i - 1) / SCAN); hi = t; break; }
      prev = d;
    }
    if (lo < 0) return rMax;                       // rMax 까지 계속 내부 → 클램프
    for (let i = 0; i < 12; i++) {
      const m = (lo + hi) * 0.5;
      if (field(cx + dx * m, cy, cz + dz * m, list) < 0) lo = m; else hi = m;
    }
    const r = (lo + hi) * 0.5;
    return r < rMin ? rMin : (r > rMax ? rMax : r);
  }

  /* ---------------------------------------------------------- 링 테이블 */
  /* 각 항목: [y, rMax(등가면 탐색 상한), rIn(안쪽 방향 상한=자기 캡슐 반지름),
               재질인덱스, 0=항상 1=high 전용] */
  const R_TORSO = [
    [0.884, 0.150, 0, 2, 0], [0.906, 0.160, 0, 2, 1], [0.928, 0.172, 0, 2, 0],
    [0.952, 0.176, 0, 2, 1], [0.978, 0.170, 0, 2, 0], [1.008, 0.162, 0, 2, 1],
    [1.040, 0.150, 0, 2, 0], [1.072, 0.144, 0, 2, 1], [1.104, 0.142, 0, 2, 0],
    [1.138, 0.148, 0, 2, 1], [1.172, 0.158, 0, 2, 0], [1.206, 0.172, 0, 1, 1],
    [1.242, 0.186, 0, 1, 0], [1.280, 0.190, 0, 1, 1], [1.316, 0.192, 0, 1, 0],
    [1.350, 0.192, 0, 1, 1], [1.382, 0.190, 0, 1, 0], [1.410, 0.185, 0, 1, 1],
    [1.434, 0.174, 0, 1, 0], [1.452, 0.162, 0, 1, 1], [1.468, 0.150, 0, 0, 0],
    [1.486, 0.130, 0, 0, 1], [1.502, 0.096, 0, 0, 0], [1.520, 0.078, 0, 0, 1],
    [1.540, 0.076, 0, 0, 0], [1.562, 0.086, 0, 0, 1], [1.586, 0.098, 0, 0, 0],
    [1.612, 0.106, 0, 0, 1], [1.640, 0.110, 0, 0, 0], [1.668, 0.112, 0, 0, 1],
    [1.696, 0.112, 0, 0, 0], [1.722, 0.110, 0, 0, 1], [1.750, 0.102, 0, 0, 0],
    [1.778, 0.090, 0, 0, 1], [1.806, 0.072, 0, 0, 0], [1.830, 0.046, 0, 0, 0]
  ];
  const R_ARM = [
    [1.474, 0.060, 0.045, 3, 0], [1.462, 0.075, 0.055, 3, 1], [1.446, 0.086, 0.068, 3, 0],
    [1.428, 0.094, 0.078, 3, 1], [1.408, 0.098, 0.082, 3, 0], [1.386, 0.096, 0.080, 3, 1],
    [1.360, 0.092, 0.076, 3, 0], [1.330, 0.082, 0.070, 3, 1], [1.298, 0.076, 0.066, 3, 0],
    [1.264, 0.072, 0.062, 3, 1], [1.230, 0.066, 0.058, 3, 0], [1.196, 0.062, 0.055, 3, 1],
    [1.164, 0.058, 0.052, 3, 0], [1.140, 0.055, 0.049, 3, 1], [1.122, 0.054, 0.048, 4, 0],
    [1.100, 0.058, 0.050, 4, 1], [1.072, 0.062, 0.052, 4, 0], [1.040, 0.062, 0.052, 4, 1],
    [1.008, 0.060, 0.050, 4, 0], [0.972, 0.056, 0.047, 4, 1], [0.936, 0.050, 0.043, 4, 0],
    [0.900, 0.044, 0.038, 4, 1], [0.872, 0.040, 0.035, 4, 0], [0.856, 0.056, 0.043, 5, 0],
    [0.836, 0.070, 0.046, 5, 1], [0.812, 0.076, 0.046, 5, 0], [0.788, 0.070, 0.045, 5, 1],
    [0.762, 0.060, 0.044, 5, 0], [0.736, 0.054, 0.042, 5, 1], [0.712, 0.048, 0.038, 5, 0]
  ];
  const R_LEG = [
    [0.958, 0.070, 0.088, 6, 0], [0.940, 0.078, 0.094, 6, 1], [0.916, 0.090, 0.098, 6, 0],
    [0.888, 0.104, 0.098, 6, 1], [0.856, 0.112, 0.096, 6, 0], [0.820, 0.114, 0.094, 6, 1],
    [0.782, 0.112, 0.092, 6, 0], [0.742, 0.110, 0.090, 6, 1], [0.700, 0.108, 0.088, 6, 0],
    [0.658, 0.102, 0.084, 6, 1], [0.616, 0.096, 0.080, 6, 0], [0.574, 0.090, 0.076, 6, 1],
    [0.534, 0.082, 0.072, 6, 0], [0.500, 0.076, 0.068, 6, 1], [0.478, 0.074, 0.066, 7, 0],
    [0.456, 0.076, 0.066, 7, 1], [0.430, 0.080, 0.068, 7, 0], [0.400, 0.082, 0.068, 7, 1],
    [0.368, 0.080, 0.066, 7, 0], [0.334, 0.076, 0.063, 7, 1], [0.298, 0.070, 0.059, 7, 0],
    [0.260, 0.064, 0.055, 7, 1], [0.222, 0.058, 0.051, 7, 0], [0.184, 0.052, 0.047, 7, 1],
    [0.148, 0.048, 0.044, 7, 0], [0.114, 0.044, 0.041, 7, 1], [0.086, 0.042, 0.039, 7, 0],
    [0.068, 0.062, 0.055, 8, 0], [0.056, 0.105, 0.100, 8, 1], [0.044, 0.155, 0.150, 8, 0],
    [0.030, 0.172, 0.168, 8, 1], [0.016, 0.176, 0.172, 8, 0], [0.006, 0.172, 0.168, 8, 0]
  ];

  /* 구간별 선형보간 (테이블은 y 내림차순) */
  function pw(y, tb) {
    if (y >= tb[0][0]) return tb[0][1];
    for (let i = 1; i < tb.length; i++) {
      if (y >= tb[i][0]) {
        const t = (y - tb[i][0]) / (tb[i - 1][0] - tb[i][0]);
        return tb[i][1] + (tb[i - 1][1] - tb[i][1]) * t;
      }
    }
    return tb[tb.length - 1][1];
  }
  const ARM_AX = [[1.412, 0.197], [1.140, 0.213], [0.868, 0.231], [0.700, 0.236]];
  const ARM_AZ = [[1.412, 0.000], [0.900, 0.002], [0.700, 0.012]];
  const LEG_AZ = [[0.100, 0.000], [0.060, 0.008], [0.000, 0.032]];

  function smoothstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  /* ------------------------------------------------------- 튜브 스위핑 */
  /* ctx 에 정점/uv/그리드/재질별 인덱스를 누적한다.
     rings: 위 테이블, side: +1(왼쪽) -1(오른쪽) 0(몸통), flip: 링 순서가 하강 */
  function sweep(ctx, prims, rings, opt) {
    const NC = ctx.nc, side = opt.side || 0, flip = !!opt.flip;
    const grid = [], nR = rings.length;
    const cxs = [], cys = [], czs = [];

    for (let i = 0; i < nR; i++) {
      const y = rings[i][0];
      cxs.push(opt.cx(y)); cys.push(y); czs.push(opt.cz(y));
    }
    /* v 좌표: 같은 재질이 이어지는 구간마다 0~1 로 리셋 */
    const vs = new Array(nR);
    for (let i = 0; i < nR;) {
      let j = i; while (j + 1 < nR && rings[j + 1][3] === rings[i][3]) j++;
      for (let k = i; k <= j; k++) vs[k] = j === i ? 0 : (k - i) / (j - i);
      i = j + 1;
    }

    for (let i = 0; i < nR; i++) {
      const rw = rings[i], row = [];
      const cx = cxs[i], cy = cys[i], cz = czs[i];
      const near = cull(prims, cx, cy, cz, rw[1] + 0.06);
      for (let j = 0; j <= NC; j++) {
        const u = j / NC, th = -Math.PI / 2 + Math.PI * 2 * u;
        const dx = Math.cos(th), dz = Math.sin(th);   // u=0.5 → +Z(정면)
        let rmax = rw[1], bias = 1;
        if (side !== 0) {
          /* 안쪽(몸통 방향) 광선은 자기 캡슐 반지름으로 제한 →
             몸통 표면 아래로 숨어서 표면끼리 겹쳐 깜빡이는 것을 막는다 */
          const w = smoothstep(-0.10, 0.50, -dx * side);
          rmax = rw[1] * (1 - w) + rw[2] * w;
          bias = 1 - 0.035 * w;
        }
        const r = march(near, cx, cy, cz, dx, dz, rmax * 0.22, rmax) * bias;
        row.push(ctx.pos.length / 3);
        ctx.pos.push(cx + dx * r, cy, cz + dz * r);
        ctx.uv.push(u, vs[i]);
        ctx.tag.push(opt.tag);
      }
      grid.push(row);
    }

    /* 삼각형: 링 i(=a,b) 와 링 i+1(=d,c) 을 잇는다 */
    for (let i = 0; i + 1 < nR; i++) {
      const A = grid[i], B = grid[i + 1], bucket = ctx.buk[rings[i][3]];
      for (let j = 0; j < NC; j++) {
        const a = A[j], b = A[j + 1], c = B[j + 1], d = B[j];
        if (flip) { bucket.push(a, b, c, a, c, d); }
        else { bucket.push(a, d, c, a, c, b); }
      }
    }

    /* 양 끝 캡: 축 위의 한 점으로 부채꼴 마감 */
    function cap(atStart, P, m) {
      const ap = ctx.pos.length / 3;
      ctx.pos.push(P[0], P[1], P[2]);
      ctx.uv.push(0.5, atStart ? 0 : 1);
      ctx.tag.push(opt.tag);
      const A = grid[atStart ? 0 : nR - 1], bucket = ctx.buk[m];
      for (let j = 0; j < NC; j++) {
        const a = A[j], b = A[j + 1];
        if (atStart !== flip) bucket.push(ap, a, b); else bucket.push(ap, b, a);
      }
      return ap;
    }
    const apex = [];
    if (opt.capA) apex.push(cap(true, opt.capA, opt.capAm));
    if (opt.capB) apex.push(cap(false, opt.capB, opt.capBm));
    ctx.grids.push({ grid: grid, apex: apex, nR: nR });
  }

  /* ------------------------------------------------------------- 뼈대 */
  /* [이름, 부모, 로컬 x,y,z] — 모든 사지 본은 로컬 -Y 로 뻗는다 */
  const BONE_DEF = [
    ['hips', null, 0, 0.98, 0],
    ['spine', 'hips', 0, 0.02, 0],
    ['chest', 'spine', 0, 0.16, 0],
    ['neck', 'chest', 0, 0.32, 0],
    ['head', 'neck', 0, 0.09, 0],
    ['shoulderL', 'chest', 0.20, 0.26, 0],
    ['elbowL', 'shoulderL', 0, -0.29, 0],
    ['handL', 'elbowL', 0, -0.27, 0],
    ['shoulderR', 'chest', -0.20, 0.26, 0],
    ['elbowR', 'shoulderR', 0, -0.29, 0],
    ['handR', 'elbowR', 0, -0.27, 0],
    ['hipL', 'hips', 0.105, -0.05, 0],
    ['kneeL', 'hipL', 0, -0.45, 0],
    ['footL', 'kneeL', 0, -0.43, 0],
    ['hipR', 'hips', -0.105, -0.05, 0],
    ['kneeR', 'hipR', 0, -0.45, 0],
    ['footR', 'kneeR', 0, -0.43, 0]
  ];

  /* 가중치용 본 "선분"(살점이 붙는 실제 구간) + eps(부드러움) + R(뼈 굵기).
     R 을 빼서 거리를 재야 몸통처럼 굵은 부위가 팔 본에게 뺏기지 않는다. */
  function boneSegs() {
    const S = {
      hips: [0, 0.900, 0, 0, 1.000, 0, 0.055, 0.115],
      spine: [0, 1.000, 0, 0, 1.160, 0, 0.055, 0.105],
      chest: [0, 1.160, 0, 0, 1.430, 0, 0.055, 0.125],
      neck: [0, 1.455, 0, 0, 1.560, 0, 0.040, 0.045],
      head: [0, 1.580, 0, 0, 1.790, -0.01, 0.050, 0.075]
    };
    for (let si = 0; si < 2; si++) {
      const s = si === 0 ? 1 : -1, D = si === 0 ? 'L' : 'R';
      S['shoulder' + D] = [s * 0.198, 1.418, 0, s * 0.213, 1.145, 0, 0.040, 0.050];
      S['elbow' + D] = [s * 0.215, 1.132, 0, s * 0.231, 0.872, 0, 0.035, 0.038];
      S['hand' + D] = [s * 0.233, 0.862, 0, s * 0.236, 0.712, 0.012, 0.030, 0.032];
      S['hip' + D] = [s * 0.105, 0.930, 0, s * 0.105, 0.500, 0, 0.045, 0.065];
      S['knee' + D] = [s * 0.105, 0.478, 0, s * 0.105, 0.075, 0, 0.040, 0.048];
      S['foot' + D] = [s * 0.105, 0.052, -0.030, s * 0.105, 0.030, 0.130, 0.040, 0.045];
    }
    return BONE_DEF.map(function (b) { return S[b[0]]; });
  }

  /* 점 → 선분 거리 */
  function segDist(px, py, pz, S) {
    const ax = S[0], ay = S[1], az = S[2];
    const bx = S[3] - ax, by = S[4] - ay, bz = S[5] - az;
    const qx = px - ax, qy = py - ay, qz = pz - az;
    const l2 = bx * bx + by * by + bz * bz;
    let t = l2 > 1e-9 ? (qx * bx + qy * by + qz * bz) / l2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const dx = qx - bx * t, dy = qy - by * t, dz = qz - bz * t;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* 부위별 허용 본 마스크 — 차렷 자세에서 손이 허벅지 바로 옆이라
     거리 기반 가중치만 쓰면 손 본이 허벅지를 끌고 간다. 사슬을 분리한다.
     0=몸통(전부 허용) 1=팔L 2=팔R 3=다리L 4=다리R */
  /* 값은 영향력 배수(0=차단). 몸통 정점에서 사지 본은 0.35 로 눌러
     가슴 앞면이 팔 흔들림에 끌려가지 않게 한다. */
  const A0 = 0.35;
  const ALLOW = [
    [1, 1, 1, 1, 1, A0, A0, A0, A0, A0, A0, A0, A0, A0, A0, A0, A0],
    [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0],
    [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0],
    [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1]
  ];

  /* 스킨 가중치: 1/(d^4+eps^4) → 정규화 → 링 이웃 평활 → 상위 4개 */
  function skinning(ctx, segs, count) {
    const NB = segs.length, W = new Float32Array(count * NB);
    for (let v = 0; v < count; v++) {
      const px = ctx.pos[v * 3], py = ctx.pos[v * 3 + 1], pz = ctx.pos[v * 3 + 2];
      const tg = ctx.tag[v] || 0, al = ALLOW[tg];
      let sum = 0;
      for (let b = 0; b < NB; b++) {
        if (!al[b]) { W[v * NB + b] = 0; continue; }
        const S = segs[b], e = S[6];
        let d = segDist(px, py, pz, S) - S[7];
        if (d < 0) d = 0;
        const w = al[b] / (d * d * d * d + e * e * e * e);
        W[v * NB + b] = w; sum += w;
      }
      if (sum > 0) for (let b = 0; b < NB; b++) W[v * NB + b] /= sum;
      /* 사지 뿌리(겨드랑이·사타구니)는 몸통 본을 강제로 섞어 찢어지지 않게 한다 */
      let mixB = -1, mix = 0;
      if (tg === 1 || tg === 2) { mixB = 2; mix = 0.45 * smoothstep(1.350, 1.470, py); }
      else if (tg === 3 || tg === 4) { mixB = 0; mix = 0.45 * smoothstep(0.890, 0.965, py); }
      if (mix > 0.001) {
        for (let b = 0; b < NB; b++) W[v * NB + b] *= (1 - mix);
        W[v * NB + mixB] += mix;
      }
    }
    /* 표면 그리드 이웃끼리 평활 — 관절에서 가중치가 급변하지 않게(끊김 방지) */
    const NC = ctx.nc, tmp = new Float32Array(count * NB), nb = [0, 0, 0, 0];
    for (let pass = 0; pass < 3; pass++) {
      tmp.set(W);
      for (let g = 0; g < ctx.grids.length; g++) {
        const G = ctx.grids[g].grid, nR = G.length;
        for (let i = 0; i < nR; i++) {
          for (let j = 0; j <= NC; j++) {
            const v = G[i][j];
            nb[0] = G[i][j === 0 ? NC - 1 : j - 1];
            nb[1] = G[i][j === NC ? 1 : j + 1];
            nb[2] = G[i > 0 ? i - 1 : i][j];
            nb[3] = G[i < nR - 1 ? i + 1 : i][j];
            for (let b = 0; b < NB; b++) {
              let a = tmp[v * NB + b] * 1.2;
              for (let k = 0; k < 4; k++) a += tmp[nb[k] * NB + b] * 0.45;
              W[v * NB + b] = a / 3.0;
            }
          }
        }
      }
    }
    /* 상위 4개만 남기고 합=1 정규화 (합이 1이 아니면 몸이 쪼그라든다) */
    const idx = new Uint16Array(count * 4), wgt = new Float32Array(count * 4);
    for (let v = 0; v < count; v++) {
      let i0 = 0, i1 = 0, i2 = 0, i3 = 0, w0 = -1, w1 = -1, w2 = -1, w3 = -1;
      for (let b = 0; b < NB; b++) {
        const w = W[v * NB + b];
        if (w > w0) { w3 = w2; i3 = i2; w2 = w1; i2 = i1; w1 = w0; i1 = i0; w0 = w; i0 = b; }
        else if (w > w1) { w3 = w2; i3 = i2; w2 = w1; i2 = i1; w1 = w; i1 = b; }
        else if (w > w2) { w3 = w2; i3 = i2; w2 = w; i2 = b; }
        else if (w > w3) { w3 = w; i3 = b; }
      }
      if (w1 < 0) w1 = 0;
      if (w2 < 0) w2 = 0;
      if (w3 < 0) w3 = 0;
      const cut = w0 * 0.05;                 // 티끌 가중치 제거
      if (w1 < cut) w1 = 0;
      if (w2 < cut) w2 = 0;
      if (w3 < cut) w3 = 0;
      const s = w0 + w1 + w2 + w3 || 1;
      idx[v * 4] = i0; idx[v * 4 + 1] = i1; idx[v * 4 + 2] = i2; idx[v * 4 + 3] = i3;
      wgt[v * 4] = w0 / s; wgt[v * 4 + 1] = w1 / s;
      wgt[v * 4 + 2] = w2 / s; wgt[v * 4 + 3] = w3 / s;
    }
    return { idx: idx, wgt: wgt };
  }

  /* ------------------------------------------------------------- build */
  function build(opts) {
    opts = opts || {};
    const high = opts.quality !== 'low';
    const NC = high ? 16 : 12;
    const prims = anatomy();
    const ctx = { nc: NC, pos: [], uv: [], tag: [], grids: [], buk: [] };
    for (let i = 0; i < 9; i++) ctx.buk.push([]);
    const flt = function (t) {
      return t.filter(function (r) { return high || r[4] === 0; });
    };

    /* 몸통+머리: 사타구니 끝 → 정수리 까지 하나의 연속 링 스택 */
    sweep(ctx, prims, flt(R_TORSO), {
      side: 0, flip: false, tag: 0,
      cx: function () { return 0; },
      cz: function (y) { return y > 1.60 ? -0.014 : 0; },
      capA: [0, 0.866, 0], capAm: 2, capB: [0, 1.851, -0.016], capBm: 0
    });
    /* 팔·다리: 뿌리 링은 몸통 부피 안에서 시작해 표면을 뚫고 자라난다 */
    for (let si = 0; si < 2; si++) {
      const s = si === 0 ? 1 : -1;
      sweep(ctx, prims, flt(R_ARM), {
        side: s, flip: true, tag: si === 0 ? 1 : 2,
        cx: function (y) { return s * pw(y, ARM_AX); },
        cz: function (y) { return pw(y, ARM_AZ); },
        capA: [s * 0.196, 1.483, -0.004], capAm: 3,
        capB: [s * 0.236, 0.676, 0.014], capBm: 5
      });
      sweep(ctx, prims, flt(R_LEG), {
        side: s, flip: true, tag: si === 0 ? 3 : 4,
        cx: function () { return s * 0.105; },
        cz: function (y) { return pw(y, LEG_AZ); },
        capA: [s * 0.105, 0.972, -0.006], capAm: 6,
        capB: [s * 0.105, 0.000, 0.030], capBm: 8
      });
    }

    /* --- 지오메트리 조립: 재질 인덱스별로 인덱스를 모아 group 생성 --- */
    const count = ctx.pos.length / 3;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(ctx.pos, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(ctx.uv, 2));
    const index = [];
    for (let m = 0; m < 9; m++) {
      const b = ctx.buk[m];
      if (!b.length) continue;
      const start = index.length;
      for (let i = 0; i < b.length; i++) index.push(b[i]);
      geom.addGroup(start, b.length, m);
    }
    geom.setIndex(index);
    geom.computeVertexNormals();

    /* --- 본 계층 --- */
    const bones = [], map = {};
    for (let i = 0; i < BONE_DEF.length; i++) {
      const d = BONE_DEF[i], b = new THREE.Bone();
      b.name = d[0];
      b.position.set(d[2], d[3], d[4]);
      if (d[1]) map[d[1]].add(b);
      bones.push(b); map[d[0]] = b;
    }

    /* --- 스키닝 --- */
    const sk = skinning(ctx, boneSegs(), count);
    geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(sk.idx, 4));
    geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sk.wgt, 4));

    /* --- 재질: r128 은 material.skinning=true 가 없으면 본이 안 먹는다.
           원본을 공유하면 일반 Mesh 가 원점으로 붕괴하므로 반드시 clone --- */
    const src = opts.materials || [];
    const mats = [];
    for (let i = 0; i < 9; i++) {
      let m = src[i] || src[0];
      m = m ? m.clone() : new THREE.MeshStandardMaterial({ color: 0x9a9a9a });
      m.skinning = true;
      m.flatShading = false;
      m.needsUpdate = true;
      mats.push(m);
    }

    const mesh = new THREE.SkinnedMesh(geom, mats);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;           // 팔 들 때 화면에서 사라지는 것 방지
    mesh.add(bones[0]);                   // rootBone 은 bind 전에 mesh 의 자식으로
    mesh.bind(new THREE.Skeleton(bones)); // 인자 1개 → bindMatrix 기본값
    mesh.normalizeSkinWeights();

    const root = new THREE.Group();       // 발바닥 y=0, +Z 정면
    root.add(mesh);

    return { mesh: mesh, skeleton: mesh.skeleton, root: root, bones: map };
  }

  NS.BodyGen2 = { build: build };
})();
