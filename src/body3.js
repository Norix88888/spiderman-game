/* =========================================================================
   body3.js — 후보3: "단면 프로파일 스위핑" 인체 생성기  (NS.BodyGen3)

   신체 각 높이의 실제 단면 윤곽(슈퍼타원 rx/rz/지수)을 키 프로파일로 정의하고,
   그 링들을 세로로 이어 붙여 하나의 연속 표면으로 스위핑한다.
   삼각근은 몸통 프로파일 자체를 어깨에서 부풀려 만들고, 팔 튜브의 윗부분을
   그 삼각근 안쪽으로 밀어 넣어 어깨-팔이 끊기지 않게 잇는다.
   허벅지 윗링도 골반 내부까지 밀어 넣어 사타구니를 메운다.

   three.js r128 UMD 전용. ES 모듈 아님. 전역 THREE 사용.
   ========================================================================= */
(function () {
  const NS = (window.SPIDER = window.SPIDER || {});

  /* ======================================================================
     1. 수학 유틸
     ====================================================================== */
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  /* a→b 구간 부드러운 계단. a>b 이면 역방향(감소) 계단이 된다 */
  function ss(a, b, x) {
    if (a === b) return x < a ? 0 : 1;
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }

  /* 부호 보존 거듭제곱 — 슈퍼타원 단면용 */
  function sPow(v, e) {
    if (v >= 0) return Math.pow(v, e);
    return -Math.pow(-v, e);
  }

  /* 점 p 에서 선분 AB 까지의 거리 */
  function distSeg(px, py, pz, a, b) {
    const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
    const wx = px - a[0], wy = py - a[1], wz = pz - a[2];
    const dd = ax * ax + ay * ay + az * az;
    let t = dd > 1e-9 ? (wx * ax + wy * ay + wz * az) / dd : 0;
    t = clamp01(t);
    const dx = wx - ax * t, dy = wy - ay * t, dz = wz - az * t;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* ======================================================================
     2. 링(단면) 정의 헬퍼
        axis 'Y' : 링은 XZ 평면. 위치 = (cx + rx*fx, a, cz + rz*fz)
        axis 'Z' : 링은 XY 평면. 위치 = (cx + rx*fx, cy + rz*fz, a)
        a  : 링이 놓인 축 좌표 (Y축이면 높이, Z축이면 앞뒤)
        r1 : 좌우 반폭,  r2 : 두 번째 축 반폭
        n  : 슈퍼타원 지수 (2=타원, 클수록 상자형)
        c1 : 첫 축(X) 중심,  c2 : 두 번째 축 중심
     ====================================================================== */
  function R(a, r1, r2, n, c1, c2) {
    return { a: a, r1: r1, r2: r2, n: n || 2, c1: c1 || 0, c2: c2 || 0 };
  }

  /* ======================================================================
     3. 지오메트리 누산기
     ====================================================================== */
  function Builder() {
    this.pos = [];      // xyz
    this.uv = [];       // uv
    this.part = [];     // 정점별 소속 부위 문자열 (스키닝 후보 결정용)
    this.rad = [];      // 정점별 국소 반지름 (스키닝 eps 용)
    this.idx = [];      // 머티리얼 인덱스별 삼각형 배열
    for (let i = 0; i < 9; i++) this.idx.push([]);
  }

  Builder.prototype.vert = function (x, y, z, u, v, part, rad) {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    this.part.push(part);
    this.rad.push(rad);
    return (this.pos.length / 3) - 1;
  };

  Builder.prototype.tri = function (m, a, b, c) {
    const t = this.idx[m];
    t.push(a, b, c);
  };

  /* 링 하나를 정점으로 펼친다. side<0 이면 X 를 반전하고 매개변수도 뒤집어
     삼각형 감김(winding)을 그대로 유지한다.
     u=0.5 가 정면(+Z), u=0/1 seam 은 등쪽. 시임 정점은 중복 생성한다. */
  Builder.prototype.ring = function (r, seg, side, axis, v, part) {
    const first = (this.pos.length / 3);
    const e = 2 / r.n;
    const rad = Math.max(r.r1, r.r2);
    for (let j = 0; j <= seg; j++) {
      const u = j / seg;
      const p = side > 0 ? u : (1 - u);
      const th = -Math.PI / 2 + Math.PI * 2 * p;
      const fx = sPow(Math.cos(th), e);
      const fz = sPow(Math.sin(th), e);
      const q1 = r.c1 + r.r1 * fx;
      const q2 = r.c2 + r.r2 * fz;
      if (axis === 'Z') this.vert(side * q1, q2, r.a, u, v, part, rad);
      else this.vert(side * q1, r.a, q2, u, v, part, rad);
    }
    return first;
  };

  /* 링 목록을 스위핑해서 튜브를 만든다.
     rings 는 축 좌표 오름차순. capLo/capHi 로 양끝을 부채꼴로 막는다. */
  Builder.prototype.sweep = function (o) {
    const rings = o.rings, seg = o.seg, side = o.side || 1;
    const axis = o.axis || 'Y', mat = o.mat, part = o.part;
    const first = (this.pos.length / 3);

    /* v 좌표 : 중심선 누적 길이 기준 0~1 */
    const acc = [0];
    for (let i = 1; i < rings.length; i++) {
      const p = rings[i - 1], c = rings[i];
      const d1 = c.c1 - p.c1, d2 = c.c2 - p.c2, da = c.a - p.a;
      acc.push(acc[i - 1] + Math.sqrt(d1 * d1 + d2 * d2 + da * da));
    }
    const total = acc[acc.length - 1] || 1;

    const rows = [];
    for (let i = 0; i < rings.length; i++) {
      rows.push(this.ring(rings[i], seg, side, axis, acc[i] / total, part));
    }

    /* 사각형 → 삼각형. 축에 따라 감김이 반대다 */
    for (let i = 0; i < rows.length - 1; i++) {
      for (let j = 0; j < seg; j++) {
        const a = rows[i] + j, b = a + 1;
        const c = rows[i + 1] + j, d = c + 1;
        if (axis === 'Z') { this.tri(mat, a, b, c); this.tri(mat, b, d, c); }
        else { this.tri(mat, a, c, b); this.tri(mat, b, c, d); }
      }
    }

    /* 끝 막음 */
    const capOne = (ri, hi) => {
      const r = rings[ri];
      const h = Math.max(r.r1, r.r2) * 0.55;
      const sgn = hi ? 1 : -1;
      const x = side * r.c1;
      let ax, ay, az;
      if (axis === 'Z') { ax = x; ay = r.c2; az = r.a + sgn * h; }
      else { ax = x; ay = r.a + sgn * h; az = r.c2; }
      const apex = this.vert(ax, ay, az, 0.5, hi ? 1 : 0, part, Math.max(r.r1, r.r2));
      const row = rows[ri];
      for (let j = 0; j < seg; j++) {
        const p = row + j, q = row + j + 1;
        if (axis === 'Z') {
          if (hi) this.tri(mat, apex, p, q); else this.tri(mat, apex, q, p);
        } else {
          if (hi) this.tri(mat, apex, q, p); else this.tri(mat, apex, p, q);
        }
      }
    };
    if (o.capLo) capOne(0, false);
    if (o.capHi) capOne(rings.length - 1, true);

    return { first: first, last: (this.pos.length / 3) };
  };

  /* 밴드(재질 구간) 목록을 이어서 스위핑.
     경계 링은 양쪽 밴드가 각각 복제 생성한다(재질 시임 + UV 재시작).
     복제로 생긴 법선 균열은 weldNormals 가 나중에 봉합한다. */
  Builder.prototype.chain = function (o) {
    const bands = o.bands;
    const out = { first: (this.pos.length / 3), spans: [] };
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      out.spans.push(this.sweep({
        rings: b.rings, seg: o.seg, side: o.side, axis: o.axis,
        mat: b.mat, part: o.part,
        capLo: (i === 0) && !!o.capLo,
        capHi: (i === bands.length - 1) && !!o.capHi
      }));
    }
    out.last = (this.pos.length / 3);
    return out;
  };

  /* 위치가 같은 정점들의 법선을 평균내어 밴드 경계의 음영 균열을 없앤다 */
  function weldNormals(pos, nrm) {
    const map = Object.create(null);
    const n = pos.length / 3;
    const key = i => (
      Math.round(pos[i * 3] * 2000) + '_' +
      Math.round(pos[i * 3 + 1] * 2000) + '_' +
      Math.round(pos[i * 3 + 2] * 2000)
    );
    for (let i = 0; i < n; i++) {
      const k = key(i);
      if (map[k]) map[k].push(i); else map[k] = [i];
    }
    for (const k in map) {
      const g = map[k];
      if (g.length < 2) continue;
      let x = 0, y = 0, z = 0;
      for (let i = 0; i < g.length; i++) {
        x += nrm[g[i] * 3]; y += nrm[g[i] * 3 + 1]; z += nrm[g[i] * 3 + 2];
      }
      const L = Math.sqrt(x * x + y * y + z * z) || 1;
      x /= L; y /= L; z /= L;
      for (let i = 0; i < g.length; i++) {
        nrm[g[i] * 3] = x; nrm[g[i] * 3 + 1] = y; nrm[g[i] * 3 + 2] = z;
      }
    }
  }

  /* ======================================================================
     4. 인체 단면 프로파일 — 총키 1.85m, 머리 0.25m(7.4등신), V 테이퍼
        가로 랜드마크: 크라운1.85 턱1.60 어깨1.42 유두1.335 허리1.10
                      장골1.00 가랑이0.90 무릎0.48 발목0.05
        rz < rx : 몸통은 앞뒤로 눌린 슈퍼타원이어야 사람으로 보인다.
     ====================================================================== */

  /* --- 몸통 : 골반 → 허리 → 흉곽 → 삼각근 → 승모근 → 목 → 머리 (한 줄기) --- */
  const T_ABDOMEN = [           // 재질 2 (하의)
    R(0.885, 0.150, 0.112, 2.8, 0, 0.004),
    R(0.920, 0.176, 0.128, 2.8, 0, 0.002),   // 둔부 최대
    R(0.965, 0.166, 0.120, 2.7, 0, 0.002),
    R(1.000, 0.155, 0.110, 2.7, 0, 0.000),   // 장골
    R(1.045, 0.140, 0.102, 2.6, 0, 0.000),
    R(1.100, 0.132, 0.098, 2.6, 0, 0.002),   // 허리 최협
    R(1.130, 0.137, 0.099, 2.6, 0, 0.003)
  ];
  const T_CHEST = [             // 재질 1 (상의)
    R(1.130, 0.137, 0.099, 2.6, 0, 0.003),
    R(1.180, 0.146, 0.101, 2.6, 0, 0.004),   // 하부 늑골
    R(1.240, 0.160, 0.108, 2.6, 0, 0.006),
    R(1.300, 0.173, 0.114, 2.55, 0, 0.008),
    R(1.335, 0.181, 0.116, 2.50, 0, 0.006),  // 유두선 (가슴 최대)
    R(1.375, 0.216, 0.112, 2.50, 0, 0.002),  // 어깨로 벌어짐
    R(1.405, 0.252, 0.108, 2.45, 0, -0.002),
    R(1.425, 0.268, 0.104, 2.40, 0, -0.004), // 어깨선 = 삼각근 최대
    R(1.445, 0.238, 0.100, 2.40, 0, -0.006),
    R(1.465, 0.170, 0.094, 2.40, 0, -0.008), // 승모근
    R(1.485, 0.105, 0.080, 2.30, 0, -0.008),
    R(1.500, 0.068, 0.062, 2.20, 0, -0.006)  // 목 밑동
  ];
  const T_HEAD = [              // 재질 0 (머리/목)
    R(1.500, 0.068, 0.062, 2.20, 0, -0.006),
    R(1.545, 0.062, 0.059, 2.20, 0, -0.006), // 목
    R(1.585, 0.063, 0.062, 2.20, 0, -0.004),
    R(1.615, 0.074, 0.085, 2.40, 0, 0.008),  // 턱
    R(1.645, 0.083, 0.097, 2.50, 0, 0.008),  // 턱선/입
    R(1.675, 0.088, 0.102, 2.60, 0, 0.002),  // 광대
    R(1.710, 0.089, 0.105, 2.60, 0, -0.004),
    R(1.745, 0.086, 0.103, 2.55, 0, -0.008), // 이마
    R(1.780, 0.079, 0.094, 2.45, 0, -0.010), // 뒤통수 볼록
    R(1.815, 0.062, 0.072, 2.35, 0, -0.010),
    R(1.840, 0.036, 0.042, 2.20, 0, -0.008)
  ];

  /* --- 팔 : 손끝 → 손 → 손목 → 전완 → 팔꿈치 → 이두 → 삼각근 (아래→위) --- */
  const A_HAND = [              // 재질 5
    R(0.672, 0.014, 0.026, 3.0, 0.200, 0.004),  // 손끝
    R(0.692, 0.019, 0.038, 3.4, 0.200, 0.004),
    R(0.722, 0.022, 0.044, 3.5, 0.200, 0.003),  // 네 손가락 뭉치
    R(0.762, 0.026, 0.047, 3.4, 0.200, 0.002),  // 너클
    R(0.800, 0.028, 0.046, 3.2, 0.200, 0.000),  // 손바닥
    R(0.832, 0.030, 0.041, 2.8, 0.200, -0.001),
    R(0.860, 0.033, 0.031, 2.1, 0.200, 0.000)   // 손목
  ];
  const A_FORE = [              // 재질 4
    R(0.860, 0.033, 0.031, 2.1, 0.200, 0.000),
    R(0.900, 0.038, 0.036, 2.1, 0.200, 0.000),
    R(0.950, 0.044, 0.042, 2.1, 0.200, 0.000),
    R(1.000, 0.049, 0.047, 2.1, 0.200, 0.000),
    R(1.050, 0.052, 0.050, 2.1, 0.201, 0.000),  // 전완 최대
    R(1.090, 0.050, 0.049, 2.1, 0.200, 0.000),
    R(1.130, 0.046, 0.046, 2.1, 0.200, 0.000)   // 팔꿈치 (얇게)
  ];
  const A_UPPER = [             // 재질 3
    R(1.130, 0.046, 0.046, 2.1, 0.200, 0.000),
    R(1.165, 0.050, 0.050, 2.1, 0.200, 0.000),
    R(1.215, 0.058, 0.057, 2.1, 0.200, 0.002),  // 이두 배
    R(1.265, 0.065, 0.063, 2.1, 0.200, 0.001),
    R(1.315, 0.072, 0.069, 2.1, 0.200, 0.000),
    R(1.365, 0.078, 0.074, 2.1, 0.199, -0.001),
    R(1.405, 0.080, 0.076, 2.2, 0.197, -0.002), // 삼각근
    R(1.435, 0.073, 0.069, 2.2, 0.194, -0.003)  // 몸통 삼각근 안으로 파묻힘
  ];
  const A_THUMB = [             // 재질 5
    R(0.744, 0.015, 0.014, 2.2, 0.188, 0.052),  // 엄지 끝
    R(0.768, 0.018, 0.017, 2.2, 0.190, 0.046),
    R(0.796, 0.021, 0.020, 2.2, 0.193, 0.036),
    R(0.822, 0.023, 0.022, 2.4, 0.196, 0.022)   // 손바닥 속에 뿌리
  ];

  /* --- 다리 : 발목 → 종아리 → 무릎 → 허벅지 → 골반 속 (아래→위) --- */
  const L_SHIN = [              // 재질 7
    R(0.075, 0.037, 0.040, 2.2, 0.092, -0.002), // 발목 (가늘게)
    R(0.115, 0.040, 0.043, 2.2, 0.092, -0.004),
    R(0.175, 0.045, 0.050, 2.2, 0.093, -0.008),
    R(0.245, 0.052, 0.058, 2.2, 0.094, -0.012),
    R(0.310, 0.058, 0.063, 2.2, 0.095, -0.014),
    R(0.370, 0.061, 0.066, 2.2, 0.096, -0.013), // 종아리 최대
    R(0.420, 0.059, 0.062, 2.2, 0.098, -0.008),
    R(0.455, 0.062, 0.060, 2.2, 0.099, -0.002),
    R(0.480, 0.064, 0.062, 2.2, 0.100, 0.002)   // 무릎
  ];
  const L_THIGH = [             // 재질 6
    R(0.480, 0.064, 0.062, 2.2, 0.100, 0.002),
    R(0.520, 0.069, 0.068, 2.2, 0.101, 0.002),
    R(0.570, 0.075, 0.074, 2.2, 0.102, 0.002),
    R(0.630, 0.082, 0.081, 2.2, 0.103, 0.002),
    R(0.700, 0.089, 0.088, 2.2, 0.104, 0.001),
    R(0.770, 0.094, 0.093, 2.2, 0.105, 0.000),
    R(0.840, 0.098, 0.097, 2.2, 0.106, -0.001),
    R(0.900, 0.101, 0.100, 2.2, 0.107, -0.002),
    R(0.950, 0.102, 0.101, 2.2, 0.107, -0.003), // 골반 안으로
    R(0.990, 0.096, 0.094, 2.2, 0.107, -0.004)
  ];

  /* --- 발 : 뒤꿈치 → 발가락 (axis Z, 링은 XY 평면) --- */
  const F_SHOE = [              // 재질 8
    R(-0.070, 0.028, 0.038, 3.0, 0.092, 0.046),
    R(-0.035, 0.038, 0.046, 3.2, 0.092, 0.048),
    R(0.000, 0.044, 0.052, 3.2, 0.092, 0.050),  // 발목 아래
    R(0.045, 0.047, 0.048, 3.4, 0.093, 0.046),
    R(0.090, 0.048, 0.040, 3.5, 0.094, 0.040),  // 발등
    R(0.130, 0.045, 0.033, 3.6, 0.094, 0.034),
    R(0.165, 0.038, 0.026, 3.4, 0.094, 0.028)   // 발가락
  ];

  /* ======================================================================
     5. 머리 조각 — 코 융기 / 눈썹뼈 / 턱 / 뒤통수
     ====================================================================== */
  function sculptHead(B, from, to) {
    for (let i = from; i < to; i++) {
      const x = B.pos[i * 3], y = B.pos[i * 3 + 1], z = B.pos[i * 3 + 2];
      if (y < 1.59) continue;
      const nx = Math.abs(x);
      let dz = 0, dy = 0;
      if (z > 0.01) {
        /* 코 : 정면 좁은 폭에서만 앞으로 */
        const nose = ss(1.645, 1.688, y) * (1 - ss(1.700, 1.752, y));
        dz += 0.021 * nose * clamp01(1 - nx / 0.040);
        /* 눈썹뼈 */
        dz += 0.007 * ss(1.722, 1.742, y) * (1 - ss(1.752, 1.772, y)) * clamp01(1 - nx / 0.072);
        /* 턱 끝 */
        dz += 0.011 * ss(1.598, 1.622, y) * (1 - ss(1.632, 1.660, y)) * clamp01(1 - nx / 0.048);
      } else if (z < -0.01) {
        /* 뒤통수 더 볼록하게 */
        dz -= 0.010 * ss(1.690, 1.740, y) * (1 - ss(1.775, 1.825, y));
      }
      /* 관자놀이 살짝 눌러 두개골 느낌 */
      if (nx > 0.05 && y > 1.72) dz *= 0.6;
      B.pos[i * 3 + 2] = z + dz;
      B.pos[i * 3 + 1] = y + dy;
    }
  }

  /* ======================================================================
     6. 뼈대 정의 — 이름/오프셋은 계약이다. 절대 변경 금지.
        모든 팔다리 본은 로컬 -Y 로 뻗는다 (회전 0 = 아래).
     ====================================================================== */
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

  function buildBones() {
    const bones = {}, order = [], world = {};
    for (let i = 0; i < BONE_DEF.length; i++) {
      const d = BONE_DEF[i];
      const b = new THREE.Bone();
      b.name = d[0];
      b.position.set(d[2], d[3], d[4]);
      if (d[1]) {
        bones[d[1]].add(b);
        const w = world[d[1]];
        world[d[0]] = [w[0] + d[2], w[1] + d[3], w[2] + d[4]];
      } else {
        world[d[0]] = [d[2], d[3], d[4]];
      }
      bones[d[0]] = b;
      order.push(d[0]);
    }
    return { bones: bones, order: order, world: world };
  }

  /* ======================================================================
     7. 스키닝 — 정점 → 본 선분 거리 기반 가중치 + 부위별 후보 제한
        (차렷 자세라 팔이 몸통에 붙어 있으므로 순수 거리만으론 가슴이
         팔에 딸려간다. 부위별 후보군 + 게이트로 막는다.)
     ====================================================================== */
  function makeSkin(B, W) {
    const S = {   // 본별 대표 선분 (부모위치 → 자식위치, 말단은 가상 끝점)
      hips: [[0, 0.880, 0], [0, 1.020, 0]],
      spine: [[0, 1.000, 0], [0, 1.160, 0]],
      chest: [[0, 1.160, 0], [0, 1.440, 0]],
      neck: [W.neck, [0, 1.600, 0]],
      head: [[0, 1.600, 0], [0, 1.845, 0]]
    };
    ['L', 'R'].forEach(function (sd) {
      const s = sd === 'L' ? 1 : -1;
      S['shoulder' + sd] = [W['shoulder' + sd], W['elbow' + sd]];
      S['elbow' + sd] = [W['elbow' + sd], W['hand' + sd]];
      S['hand' + sd] = [W['hand' + sd], [s * 0.20, 0.700, 0]];
      S['hip' + sd] = [W['hip' + sd], W['knee' + sd]];
      S['knee' + sd] = [W['knee' + sd], W['foot' + sd]];
      S['foot' + sd] = [W['foot' + sd], [s * 0.098, 0.030, 0.140]];
    });

    /* 부위별 후보 본. g 가 있으면 "고정 지분" 게이트, 없으면 거리 경쟁 */
    const gDelt = function (s) {
      return function (x, y) { return 0.92 * ss(s * 0.12, s * 0.24, x) * ss(1.290, 1.425, y); };
    };
    const gGlute = function (s) {
      return function (x, y) { return 0.50 * ss(1.000, 0.900, y) * ss(s * 0.030, s * 0.110, x); };
    };
    const gArmPit = function (x, y) { return 0.45 * ss(1.300, 1.442, y); };
    const gPelvis = function (x, y) { return 0.50 * ss(0.900, 1.000, y); };

    const CAND = {
      torso: [
        { b: 'hips' }, { b: 'spine' }, { b: 'chest' }, { b: 'neck' }, { b: 'head' },
        { b: 'shoulderL', g: gDelt(1) }, { b: 'shoulderR', g: gDelt(-1) },
        { b: 'hipL', g: gGlute(1) }, { b: 'hipR', g: gGlute(-1) }
      ],
      armL: [{ b: 'shoulderL' }, { b: 'elbowL' }, { b: 'handL' }, { b: 'chest', g: gArmPit }],
      armR: [{ b: 'shoulderR' }, { b: 'elbowR' }, { b: 'handR' }, { b: 'chest', g: gArmPit }],
      legL: [{ b: 'hipL' }, { b: 'kneeL' }, { b: 'footL' }, { b: 'hips', g: gPelvis }],
      legR: [{ b: 'hipR' }, { b: 'kneeR' }, { b: 'footR' }, { b: 'hips', g: gPelvis }],
      footL: [{ b: 'kneeL' }, { b: 'footL' }],
      footR: [{ b: 'kneeR' }, { b: 'footR' }]
    };
    return { S: S, CAND: CAND };
  }

  function computeSkinAttrs(B, W, boneIndex) {
    const sk = makeSkin(B, W), S = sk.S, CAND = sk.CAND;
    const n = B.pos.length / 3;
    const SI = new Uint16Array(n * 4);
    const SW = new Float32Array(n * 4);
    const acc = [];

    for (let i = 0; i < n; i++) {
      const x = B.pos[i * 3], y = B.pos[i * 3 + 1], z = B.pos[i * 3 + 2];
      const set = CAND[B.part[i]] || CAND.torso;
      const eps = Math.max(0.022, B.rad[i] * 0.34);
      const e3 = eps * eps * eps;

      acc.length = 0;
      let gsum = 0;
      for (let k = 0; k < set.length; k++) {
        if (!set[k].g) continue;
        const g = set[k].g(x, y, z);
        if (g > 1e-4) { acc.push({ b: set[k].b, w: g }); gsum += g; }
      }
      if (gsum > 0.9) {                       // 고정 지분이 과하면 눌러준다
        const f = 0.9 / gsum;
        for (let k = 0; k < acc.length; k++) acc[k].w *= f;
        gsum = 0.9;
      }
      /* 나머지 지분을 거리 경쟁으로 배분 */
      const rest = 1 - gsum;
      let dsum = 0;
      const dl = [];
      for (let k = 0; k < set.length; k++) {
        if (set[k].g) continue;
        const seg = S[set[k].b];
        const d = distSeg(x, y, z, seg[0], seg[1]);
        const w = 1 / (d * d * d + e3);
        dl.push({ b: set[k].b, w: w });
        dsum += w;
      }
      if (dsum > 0) {
        for (let k = 0; k < dl.length; k++) {
          acc.push({ b: dl[k].b, w: dl[k].w / dsum * rest });
        }
      }

      acc.sort(function (a, b) { return b.w - a.w; });
      let tot = 0;
      const m = Math.min(4, acc.length);
      for (let k = 0; k < m; k++) tot += acc[k].w;
      if (tot <= 0) { SI[i * 4] = boneIndex.hips; SW[i * 4] = 1; continue; }
      for (let k = 0; k < 4; k++) {
        if (k < m) {
          SI[i * 4 + k] = boneIndex[acc[k].b];
          SW[i * 4 + k] = acc[k].w / tot;
        } else { SI[i * 4 + k] = 0; SW[i * 4 + k] = 0; }
      }
    }
    return { index: SI, weight: SW };
  }

  /* ======================================================================
     8. build
     ====================================================================== */
  function build(opts) {
    opts = opts || {};
    const hi = opts.quality !== 'low';
    const SEG = hi
      ? { torso: 18, arm: 16, leg: 16, hand: 12, foot: 12, thumb: 8 }
      : { torso: 12, arm: 10, leg: 10, hand: 8, foot: 8, thumb: 6 };

    const B = new Builder();

    /* --- 몸통 + 목 + 머리 : 하나의 연속 튜브 --- */
    const torsoSpan = B.chain({
      bands: [
        { rings: T_ABDOMEN, mat: 2 },
        { rings: T_CHEST, mat: 1 },
        { rings: T_HEAD, mat: 0 }
      ],
      seg: SEG.torso, side: 1, axis: 'Y', part: 'torso',
      capLo: true, capHi: true
    });
    sculptHead(B, torsoSpan.first, torsoSpan.last);

    /* --- 팔(손 포함) + 엄지 --- */
    [1, -1].forEach(function (s) {
      const part = s > 0 ? 'armL' : 'armR';
      B.chain({
        bands: [
          { rings: A_HAND, mat: 5 },
          { rings: A_FORE, mat: 4 },
          { rings: A_UPPER, mat: 3 }
        ],
        seg: SEG.arm, side: s, axis: 'Y', part: part,
        capLo: true, capHi: true
      });
      B.sweep({
        rings: A_THUMB, seg: SEG.thumb, side: s, axis: 'Y',
        mat: 5, part: part, capLo: true, capHi: true
      });
    });

    /* --- 다리 --- */
    [1, -1].forEach(function (s) {
      B.chain({
        bands: [
          { rings: L_SHIN, mat: 7 },
          { rings: L_THIGH, mat: 6 }
        ],
        seg: SEG.leg, side: s, axis: 'Y', part: s > 0 ? 'legL' : 'legR',
        capLo: true, capHi: true
      });
    });

    /* --- 발 (앞뒤로 스위핑, 밑창은 평평하게 눌러 접지) --- */
    [1, -1].forEach(function (s) {
      const sp = B.sweep({
        rings: F_SHOE, seg: SEG.foot, side: s, axis: 'Z',
        mat: 8, part: s > 0 ? 'footL' : 'footR', capLo: true, capHi: true
      });
      for (let i = sp.first; i < sp.last; i++) {
        if (B.pos[i * 3 + 1] < 0.007) B.pos[i * 3 + 1] = 0.007;
      }
    });

    /* --- 지오메트리 조립 --- */
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));

    let all = [];
    for (let mi = 0; mi < 9; mi++) {
      const arr = B.idx[mi];
      if (!arr.length) continue;
      geom.addGroup(all.length, arr.length, mi);
      all = all.concat(arr);
    }
    geom.setIndex(all);
    geom.computeVertexNormals();
    weldNormals(geom.attributes.position.array, geom.attributes.normal.array);
    geom.attributes.normal.needsUpdate = true;

    /* --- 뼈대 --- */
    const bk = buildBones();
    const boneIndex = {};
    const boneArr = [];
    for (let i = 0; i < bk.order.length; i++) {
      boneIndex[bk.order[i]] = i;
      boneArr.push(bk.bones[bk.order[i]]);
    }

    const skin = computeSkinAttrs(B, bk.world, boneIndex);
    geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skin.index, 4));
    geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skin.weight, 4));
    geom.computeBoundingSphere();

    /* --- 재질 : r128 은 skinning 플래그가 켜져야 본이 먹는다.
           원본을 그대로 쓰면 조각인형 Mesh 가 붕괴하므로 반드시 clone --- */
    const src = opts.materials || [];
    const mats = [];
    for (let i = 0; i < 9; i++) {
      let m = src[i] || src[src.length - 1];
      m = m ? m.clone() : new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.6 });
      m.skinning = true;
      m.flatShading = false;
      m.needsUpdate = true;
      mats.push(m);
    }

    /* --- SkinnedMesh 바인딩 (r128 규약) --- */
    const mesh = new THREE.SkinnedMesh(geom, mats);
    mesh.add(boneArr[0]);                 // rootBone 은 mesh 의 자식
    mesh.updateMatrixWorld(true);         // 역바인드 행렬 계산 전에 월드 갱신
    const skeleton = new THREE.Skeleton(boneArr);
    mesh.bind(skeleton);                  // 인자 1개 → 내부에서 다시 계산 (안전)
    mesh.normalizeSkinWeights();          // 합=1 보장 (안전장치)
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;           // 팔 들면 사라지는 것 방지

    const root = new THREE.Group();       // 발바닥 y=0, +Z 정면
    root.add(mesh);

    return { mesh: mesh, skeleton: skeleton, root: root, bones: bk.bones };
  }

  NS.BodyGen3 = { build: build };
})();
