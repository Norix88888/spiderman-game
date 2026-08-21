/* =========================================================================
   body1.js — 후보 1 : 링 스택 + 슈퍼타원 단면 SkinnedMesh 인체 생성기
   ------------------------------------------------------------------------
   접근: 몸통+머리를 "가랑이 → 정수리" 하나의 세로 링 스택으로 뽑고,
         팔/다리는 어깨/골반 안쪽에서 시작하는 링 스택으로 분기시켜
         몸통 표면 안쪽에 파묻어 이어 붙인다(용접 대체 — 틈이 생기지 않음).
         단면은 원이 아니라 슈퍼타원(앞뒤로 눌린 형태).
   three.js r128 UMD / 전역 THREE / ES 모듈 금지
   ========================================================================= */
(function () {
  'use strict';

  var NS = (window.SPIDER = window.SPIDER || {});

  /* ===================================================================
     1. 본 정의 — [이름, 부모, x, y, z]  (부모 상대 좌표)
     팔다리 본은 전부 로컬 -Y 로 뻗는다(회전 0 = 아래로).
     =================================================================== */
  var BONE_DEF = [
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

  /* 정지 자세(모든 회전 0)에서의 월드 좌표를 미리 계산 — 스키닝 가중치용 */
  function restWorld() {
    var w = {}, i, d, p;
    for (i = 0; i < BONE_DEF.length; i++) {
      d = BONE_DEF[i];
      p = d[1] ? w[d[1]] : { x: 0, y: 0, z: 0 };
      w[d[0]] = { x: p.x + d[2], y: p.y + d[3], z: p.z + d[4] };
    }
    return w;
  }
  var W = restWorld();

  /* 본별 "영향 선분" (부모위치 → 자식위치). 말단 본은 가상의 끝점을 준다.
     몸통 본은 실제 살덩이를 덮도록 선분을 넉넉히 잡는다. */
  function boneSegments() {
    function S(ax, ay, az, bx, by, bz) {
      return { ax: ax, ay: ay, az: az, bx: bx, by: by, bz: bz };
    }
    function L(a, b) { return S(W[a].x, W[a].y, W[a].z, W[b].x, W[b].y, W[b].z); }
    return {
      hips: S(0, 0.895, 0, 0, 1.00, 0),
      spine: S(0, 1.00, 0, 0, 1.16, 0),
      chest: S(0, 1.16, 0, 0, 1.44, 0),
      neck: S(0, 1.48, 0, 0, 1.60, 0),
      head: S(0, 1.61, -0.01, 0, 1.81, -0.01),
      shoulderL: L('shoulderL', 'elbowL'),
      elbowL: L('elbowL', 'handL'),
      handL: S(W.handL.x, W.handL.y, 0, W.handL.x, 0.672, 0.006),
      shoulderR: L('shoulderR', 'elbowR'),
      elbowR: L('elbowR', 'handR'),
      handR: S(W.handR.x, W.handR.y, 0, W.handR.x, 0.672, 0.006),
      hipL: L('hipL', 'kneeL'),
      kneeL: L('kneeL', 'footL'),
      footL: S(W.footL.x, 0.05, -0.02, W.footL.x, 0.028, 0.17),
      hipR: L('hipR', 'kneeR'),
      kneeR: L('kneeR', 'footR'),
      footR: S(W.footR.x, 0.05, -0.02, W.footR.x, 0.028, 0.17)
    };
  }
  var SEG = boneSegments();

  function distSeg(px, py, pz, s) {
    var vx = s.bx - s.ax, vy = s.by - s.ay, vz = s.bz - s.az;
    var wx = px - s.ax, wy = py - s.ay, wz = pz - s.az;
    var vv = vx * vx + vy * vy + vz * vz;
    var t = vv > 1e-9 ? (wx * vx + wy * vy + wz * vz) / vv : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var dx = wx - vx * t, dy = wy - vy * t, dz = wz - vz * t;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* ===================================================================
     2. 지오메트리 빌더 — 링 스택 전용
     =================================================================== */
  var MAT_HEAD = 0, MAT_CHEST = 1, MAT_ABS = 2, MAT_UARM = 3,
      MAT_FARM = 4, MAT_HAND = 5, MAT_THIGH = 6, MAT_SHIN = 7, MAT_FOOT = 8;

  function Builder(seg) {
    this.N = seg;              // 둘레 분할 수
    this.pos = [];             // 정점 좌표
    this.uv = [];              // uv
    this.sec = [];             // 정점별 섹션 id (스키닝 허용본 결정)
    this.idx = [[], [], [], [], [], [], [], [], []]; // 재질별 인덱스 버킷
    this.sections = [];        // {allow:{본이름:배율}}
  }

  Builder.prototype.section = function (allow) {
    this.sections.push({ allow: allow });
    return this.sections.length - 1;
  };

  /* 슈퍼타원 성분: sign(t)*|t|^(2/n) */
  function se(t, e) {
    var a = Math.abs(t);
    if (a < 1e-6) return 0;
    return (t < 0 ? -1 : 1) * Math.pow(a, e);
  }

  /* 링 하나 추가. gen(cosT, sinT, u) → [x,y,z]. u=0.5 가 +Z(정면).
     u=0 과 u=1 정점을 중복 생성해 UV 시임을 만든다. */
  Builder.prototype.ring = function (secId, v, gen) {
    var N = this.N, start = this.pos.length / 3, i, u, th, p;
    for (i = 0; i <= N; i++) {
      u = i / N;
      th = -Math.PI / 2 + Math.PI * 2 * u;
      p = gen(Math.cos(th), Math.sin(th), u);
      this.pos.push(p[0], p[1], p[2]);
      this.uv.push(u, v);
      this.sec.push(secId);
    }
    return start;
  };

  /* 단일 정점(캡 중심) */
  Builder.prototype.point = function (secId, x, y, z, u, v) {
    var s = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    this.sec.push(secId);
    return s;
  };

  /* 링 a → 링 b 를 사각형 띠로 연결 */
  Builder.prototype.strip = function (a, b, mat, flip) {
    var N = this.N, I = this.idx[mat], i, a0, a1, b0, b1;
    for (i = 0; i < N; i++) {
      a0 = a + i; a1 = a + i + 1; b0 = b + i; b1 = b + i + 1;
      if (flip) I.push(a0, b1, b0, a0, a1, b1);
      else I.push(a0, b0, b1, a0, b1, a1);
    }
  };

  /* 링을 중심점으로 덮는 부채꼴 캡 */
  Builder.prototype.cap = function (a, c, mat, flip) {
    var N = this.N, I = this.idx[mat], i;
    for (i = 0; i < N; i++) {
      if (flip) I.push(a + i, a + i + 1, c);
      else I.push(a + i, c, a + i + 1);
    }
  };

  /* ===================================================================
     3. 단면 프로파일 데이터
     [y, rx(좌우 반폭), rz(앞뒤 반깊이), cz(중심 z), n(슈퍼타원 지수), nose(코 융기)]
     rz < rx 로 눌러야 사람이 된다. 근육 랜드마크마다 링을 하나씩 둔다.
     =================================================================== */
  var TORSO = [
    [0.900, 0.150, 0.112, 0.000, 2.5, 0],
    [0.950, 0.186, 0.130, -0.004, 2.5, 0],
    [1.000, 0.172, 0.118, 0.000, 2.5, 0],
    [1.050, 0.150, 0.106, 0.000, 2.6, 0],
    [1.100, 0.134, 0.098, 0.000, 2.6, 0],   // 허리 최협
    [1.145, 0.141, 0.100, 0.000, 2.6, 0],
    [1.190, 0.151, 0.104, 0.000, 2.6, 0],
    [1.240, 0.164, 0.110, 0.002, 2.6, 0],
    [1.290, 0.174, 0.116, 0.004, 2.6, 0],
    [1.330, 0.180, 0.118, 0.006, 2.6, 0],   // 가슴
    [1.365, 0.192, 0.116, 0.004, 2.6, 0],
    [1.395, 0.201, 0.114, 0.000, 2.5, 0],
    [1.420, 0.205, 0.112, -0.002, 2.5, 0],  // 쇄골/어깨선
    [1.445, 0.190, 0.106, -0.004, 2.5, 0],
    [1.470, 0.160, 0.098, -0.006, 2.4, 0],  // 승모근 경사
    [1.495, 0.116, 0.088, -0.006, 2.3, 0],
    [1.520, 0.080, 0.074, -0.004, 2.2, 0],
    [1.550, 0.066, 0.062, 0.000, 2.2, 0],   // 목
    [1.585, 0.064, 0.062, 0.002, 2.2, 0],
    [1.612, 0.072, 0.078, 0.012, 2.3, 0],   // 턱끝
    [1.645, 0.082, 0.092, 0.010, 2.4, 0.004],
    [1.680, 0.090, 0.100, 0.004, 2.4, 0.013],  // 입
    [1.712, 0.094, 0.103, -0.002, 2.5, 0.021], // 광대 + 코
    [1.745, 0.092, 0.102, -0.008, 2.5, 0.016], // 눈
    [1.775, 0.086, 0.096, -0.012, 2.5, 0.005], // 이마
    [1.805, 0.074, 0.086, -0.016, 2.4, 0],
    [1.828, 0.056, 0.066, -0.018, 2.4, 0],
    [1.845, 0.032, 0.040, -0.018, 2.3, 0]
  ];

  /* 팔: 손목(아래) → 어깨(위) 오름차순. cx 는 좌측(+X) 기준 */
  var ARM = [
    [0.860, 0.031, 0.033, 0.200, 2.0],  // 손목
    [0.890, 0.035, 0.037, 0.200, 2.0],
    [0.935, 0.040, 0.043, 0.200, 2.0],
    [0.990, 0.047, 0.050, 0.200, 2.0],
    [1.050, 0.053, 0.055, 0.200, 2.0],  // 전완 최대
    [1.105, 0.049, 0.051, 0.200, 2.0],
    [1.130, 0.047, 0.049, 0.200, 2.1],  // 팔꿈치(가늘게)
    [1.158, 0.051, 0.052, 0.200, 2.0],
    [1.205, 0.056, 0.057, 0.199, 2.0],
    [1.262, 0.063, 0.064, 0.199, 2.0],  // 이두 배
    [1.320, 0.069, 0.069, 0.198, 2.0],
    [1.380, 0.078, 0.076, 0.198, 2.1],  // 삼각근 최대
    [1.412, 0.077, 0.074, 0.196, 2.1],
    [1.437, 0.066, 0.064, 0.191, 2.1],
    [1.457, 0.045, 0.045, 0.186, 2.1]   // 어깨 돔 (몸통 안쪽에 묻힘)
  ];

  /* 손: 손목 → 손끝. 납작하다(앞뒤 폭 rz 가 크고 좌우 두께 rx 가 작다) */
  var HAND = [
    [0.862, 0.030, 0.035, 0.200, 2.6],
    [0.838, 0.029, 0.044, 0.200, 3.0],
    [0.810, 0.028, 0.050, 0.201, 3.4],  // 손등
    [0.780, 0.026, 0.051, 0.202, 3.6],  // 너클
    [0.752, 0.023, 0.049, 0.202, 3.6],
    [0.716, 0.020, 0.045, 0.202, 3.4],  // 뭉친 네 손가락
    [0.688, 0.016, 0.036, 0.201, 3.2],
    [0.674, 0.010, 0.022, 0.200, 3.0]
  ];

  /* 엄지: 손바닥 안쪽에서 앞(+Z)으로 비스듬히. [y, r, cx, cz] */
  var THUMB = [
    [0.845, 0.021, 0.190, 0.006],
    [0.822, 0.020, 0.180, 0.026],
    [0.802, 0.017, 0.173, 0.044],
    [0.789, 0.011, 0.170, 0.055]
  ];

  /* 다리: 발목 → 골반 오름차순 */
  var LEG = [
    [0.050, 0.035, 0.037, 0.105, 2.1],  // 발목(가늘게)
    [0.110, 0.038, 0.040, 0.105, 2.1],
    [0.180, 0.043, 0.045, 0.105, 2.1],
    [0.260, 0.050, 0.053, 0.105, 2.1],
    [0.330, 0.058, 0.061, 0.105, 2.1],
    [0.380, 0.063, 0.067, 0.104, 2.1],  // 종아리 최대
    [0.425, 0.062, 0.067, 0.104, 2.1],
    [0.480, 0.062, 0.065, 0.104, 2.2],  // 무릎(가늘게)
    [0.520, 0.066, 0.069, 0.104, 2.2],
    [0.570, 0.072, 0.074, 0.104, 2.1],
    [0.640, 0.080, 0.081, 0.105, 2.1],
    [0.720, 0.088, 0.088, 0.105, 2.1],
    [0.800, 0.094, 0.093, 0.105, 2.1],
    [0.870, 0.098, 0.097, 0.105, 2.2],  // 허벅지 상단
    [0.930, 0.093, 0.095, 0.106, 2.2],
    [0.985, 0.076, 0.084, 0.108, 2.2]   // 골반 안쪽에 묻힘
  ];

  /* 발(신발): 앞(발가락) → 뒤(뒤꿈치) 로 z 내림차순. [z, rx, ry, cy, n] */
  var FOOT = [
    [0.212, 0.020, 0.013, 0.015, 3.0],
    [0.186, 0.031, 0.020, 0.022, 3.2],
    [0.140, 0.040, 0.027, 0.029, 3.2],
    [0.080, 0.043, 0.035, 0.037, 3.2],
    [0.020, 0.042, 0.043, 0.045, 3.0],
    [-0.030, 0.037, 0.047, 0.049, 2.8],
    [-0.062, 0.026, 0.041, 0.048, 2.6]
  ];

  /* ===================================================================
     4. 섹션 빌드
     =================================================================== */

  /* 링 하나의 정점 생성 함수.
     몸통은 r[3]=cz(중심 z), 사지는 r[3]=cx(중심 x, 좌측 기준) 로 해석한다. */
  function ringFnY(r, isTorso, sign) {
    var e = 2 / r[4], y = r[0], rx = r[1], rz = r[2];
    var cx = isTorso ? 0 : r[3] * sign;
    var cz = isTorso ? r[3] : 0;
    var nose = r[5] || 0;
    return function (c, s) {
      var nz = nose > 0 ? nose * Math.pow(Math.max(0, s), 8) : 0;
      return [cx + sign * rx * se(c, e), y, cz + rz * se(s, e) + nz];
    };
  }

  /* Y축 링 스택 (몸통/팔/다리 공용) */
  function stackY(B, secId, prof, sign, matOf, isTorso) {
    var starts = [], i;
    for (i = 0; i < prof.length; i++) {
      starts.push(B.ring(secId, i / (prof.length - 1), ringFnY(prof[i], isTorso, sign)));
    }
    for (i = 0; i < starts.length - 1; i++) {
      B.strip(starts[i], starts[i + 1], matOf(i), sign < 0);
    }
    return starts;
  }

  /* Z축 링 스택 (발 전용). prof = [z, rx, ry, cy, n] */
  function stackZ(B, secId, prof, sign, cx, mat) {
    var starts = [], i;
    for (i = 0; i < prof.length; i++) {
      starts.push(B.ring(secId, i / (prof.length - 1), (function (r) {
        var e = 2 / r[4], z = r[0], rx = r[1], ry = r[2], cy = r[3];
        return function (c, s) {
          return [cx * sign + sign * rx * se(c, e), cy + ry * se(s, e), z];
        };
      })(prof[i])));
    }
    for (i = 0; i < starts.length - 1; i++) B.strip(starts[i], starts[i + 1], mat, sign < 0);
    return starts;
  }

  /* 좌/우 이름 치환 헬퍼 */
  function sideAllow(side, map) {
    var out = {}, k;
    for (k in map) if (map.hasOwnProperty(k)) out[k.replace('#', side)] = map[k];
    return out;
  }

  function torsoMat(i) {
    var y = TORSO[i][0];
    if (y >= 1.495) return MAT_HEAD;
    if (y >= 1.190) return MAT_CHEST;
    return MAT_ABS;
  }
  function armMat(i) { return ARM[i][0] < 1.13 ? MAT_FARM : MAT_UARM; }
  function legMat(i) { return LEG[i][0] < 0.48 ? MAT_SHIN : MAT_THIGH; }
  function handMat() { return MAT_HAND; }

  /* ---------------- 몸통 + 목 + 머리 (하나의 연속 링 스택) ---------------- */
  function buildTorso(B) {
    var sec = B.section({
      hips: 1, spine: 1, chest: 1, neck: 1, head: 1,
      shoulderL: 0.45, shoulderR: 0.45, hipL: 0.35, hipR: 0.35
    });
    var st = stackY(B, sec, TORSO, 1, torsoMat, true);
    var last = TORSO.length - 1;
    // 가랑이(아래) 캡 — 허벅지에 묻혀 보이지 않는다
    B.cap(st[0], B.point(sec, 0, 0.860, 0, 0.5, 0), MAT_ABS, true);
    // 정수리 캡
    B.cap(st[last], B.point(sec, 0, 1.856, TORSO[last][3], 0.5, 1), MAT_HEAD, false);
  }

  /* ---------------- 팔 + 손 (손목 링을 공유해 진짜로 이어붙인다) ---------------- */
  function buildArm(B, side) {
    var sg = side === 'L' ? 1 : -1, fl = sg < 0;
    var secA = B.section(sideAllow(side, {
      'shoulder#': 1, 'elbow#': 1, 'hand#': 0.9, chest: 0.4
    }));
    var secH = B.section(sideAllow(side, { 'hand#': 1, 'elbow#': 0.65 }));
    var st = stackY(B, secA, ARM, sg, armMat, false);
    // 어깨 돔 캡 (몸통 안쪽에 파묻힘)
    B.cap(st[ARM.length - 1], B.point(secA, 0.186 * sg, 1.468, 0, 0.5, 1), MAT_UARM, fl);

    // 손: 첫 링은 팔의 손목 링(st[0])을 그대로 재사용 → 정점 공유 = 용접
    var prev = st[0], i, cur;
    for (i = 1; i < HAND.length; i++) {
      cur = B.ring(secH, i / (HAND.length - 1), ringFnY(HAND[i], false, sg));
      B.strip(prev, cur, MAT_HAND, !fl);   // 아래로 진행하므로 winding 반전
      prev = cur;
    }
    B.cap(prev, B.point(secH, 0.200 * sg, 0.668, 0, 0.5, 1), MAT_HAND, !fl);

    // 엄지 (손바닥 안쪽 → 앞아래로)
    var tp = [], j;
    for (j = THUMB.length - 1; j >= 0; j--) {
      tp.push(B.ring(secH, j / (THUMB.length - 1), (function (r) {
        var rr = r[1], cx = r[2] * sg, cz = r[3], y = r[0];
        return function (c, s) { return [cx + sg * rr * se(c, 1), y, cz + rr * se(s, 1)]; };
      })(THUMB[j])));
    }
    for (j = 0; j < tp.length - 1; j++) B.strip(tp[j], tp[j + 1], MAT_HAND, fl);
    B.cap(tp[0], B.point(secH, 0.169 * sg, 0.782, 0.060, 0.5, 0), MAT_HAND, !fl);
    B.cap(tp[tp.length - 1], B.point(secH, 0.192 * sg, 0.852, 0.002, 0.5, 1), MAT_HAND, fl);
  }

  /* ---------------- 다리 + 발 ---------------- */
  function buildLeg(B, side) {
    var sg = side === 'L' ? 1 : -1, fl = sg < 0;
    var secL = B.section(sideAllow(side, {
      'hip#': 1, 'knee#': 1, 'foot#': 0.8, hips: 0.45
    }));
    var secF = B.section(sideAllow(side, { 'foot#': 1, 'knee#': 0.6 }));
    var st = stackY(B, secL, LEG, sg, legMat, false);
    // 발목 아래 캡 (신발 안쪽에 묻힘) / 골반 위 캡 (몸통 안쪽에 묻힘)
    B.cap(st[0], B.point(secL, 0.105 * sg, 0.040, 0, 0.5, 0), MAT_SHIN, !fl);
    B.cap(st[LEG.length - 1], B.point(secL, 0.108 * sg, 0.998, 0, 0.5, 1), MAT_THIGH, fl);

    // 신발 (Z축 스택: 발가락 → 뒤꿈치)
    var fs = stackZ(B, secF, FOOT, sg, 0.105, MAT_FOOT);
    B.cap(fs[0], B.point(secF, 0.105 * sg, 0.016, 0.224, 0.5, 0), MAT_FOOT, !fl);
    B.cap(fs[FOOT.length - 1], B.point(secF, 0.105 * sg, 0.046, -0.074, 0.5, 1), MAT_FOOT, fl);
  }

  /* ===================================================================
     5. 스키닝 가중치 — 본 선분까지의 거리 기반, 상위 4개 정규화
     =================================================================== */
  var POW = 4.0, EPS = 0.02;

  function skinWeights(B, count) {
    var si = new Uint16Array(count * 4), sw = new Float32Array(count * 4);
    var bi = {}, i, j;
    for (i = 0; i < BONE_DEF.length; i++) bi[BONE_DEF[i][0]] = i;

    var cand = [];
    for (i = 0; i < count; i++) {
      var px = B.pos[i * 3], py = B.pos[i * 3 + 1], pz = B.pos[i * 3 + 2];
      var allow = B.sections[B.sec[i]].allow, name, d, w;
      cand.length = 0;
      for (name in allow) {
        if (!allow.hasOwnProperty(name)) continue;
        d = distSeg(px, py, pz, SEG[name]);
        w = allow[name] / Math.pow(d + EPS, POW);
        cand.push({ i: bi[name], w: w });
      }
      cand.sort(function (a, b) { return b.w - a.w; });
      var n = Math.min(4, cand.length), sum = 0;
      for (j = 0; j < n; j++) sum += cand[j].w;
      if (sum <= 0) { si[i * 4] = 0; sw[i * 4] = 1; continue; }
      for (j = 0; j < 4; j++) {
        if (j < n) { si[i * 4 + j] = cand[j].i; sw[i * 4 + j] = cand[j].w / sum; }
        else { si[i * 4 + j] = 0; sw[i * 4 + j] = 0; }
      }
    }
    return { index: si, weight: sw };
  }

  /* ===================================================================
     6. build — 공개 API
     =================================================================== */
  function build(opts) {
    opts = opts || {};
    var high = opts.quality !== 'low';
    var B = new Builder(high ? 18 : 12);

    buildTorso(B);
    buildArm(B, 'L');
    buildArm(B, 'R');
    buildLeg(B, 'L');
    buildLeg(B, 'R');

    var count = B.pos.length / 3;
    var skin = skinWeights(B, count);

    /* ---- 지오메트리 ---- */
    var geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
    geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skin.index, 4));
    geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skin.weight, 4));

    var all = [], start = 0, m, k, bucket;
    for (m = 0; m < 9; m++) {
      bucket = B.idx[m];
      if (!bucket.length) continue;
      for (k = 0; k < bucket.length; k++) all.push(bucket[k]);
      geom.addGroup(start, bucket.length, m);   // 0=head 1=chest 2=abdomen ...
      start += bucket.length;
    }
    geom.setIndex(count > 65535
      ? new THREE.Uint32BufferAttribute(new Uint32Array(all), 1)
      : new THREE.Uint16BufferAttribute(new Uint16Array(all), 1));
    geom.computeVertexNormals();
    geom.computeBoundingSphere();

    /* ---- 재질: r128 은 material.skinning = true 가 필수.
           원본을 공유하면 일반 Mesh 가 붕괴하므로 반드시 clone 후 켠다. ---- */
    var src = opts.materials || [];
    var mats = [], mm;
    for (m = 0; m < 9; m++) {
      mm = src[m] || src[src.length - 1];
      mm = mm ? mm.clone()
              : new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.7 });
      mm.skinning = true;
      mm.flatShading = false;
      mm.needsUpdate = true;
      mats.push(mm);
    }

    /* ---- 본 계층 ---- */
    var bones = [], map = {}, i, d, b;
    for (i = 0; i < BONE_DEF.length; i++) {
      d = BONE_DEF[i];
      b = new THREE.Bone();
      b.name = d[0];
      b.position.set(d[2], d[3], d[4]);
      map[d[0]] = b;
      bones.push(b);
      if (d[1]) map[d[1]].add(b);
    }

    /* ---- 조립 (r128 규약) ---- */
    var mesh = new THREE.SkinnedMesh(geom, mats);
    mesh.name = 'body1';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;   // 바인드 포즈 바운딩이라 팔 들면 사라짐

    var root = new THREE.Group();
    root.name = 'body1Root';
    root.add(mesh);
    root.add(bones[0]);
    root.updateMatrixWorld(true);          // 본 월드행렬 확정 후에 역행렬 계산

    var skeleton = new THREE.Skeleton(bones);
    mesh.bind(skeleton);                   // 인자 1개 — bindMatrix 직접 넘기지 말 것
    mesh.normalizeSkinWeights();           // 안전장치

    return { mesh: mesh, skeleton: skeleton, root: root, bones: map };
  }

  NS.BodyGen1 = { build: build };
})();
