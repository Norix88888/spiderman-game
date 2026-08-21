/* =========================================================================
   postfx.js — PS급 화면 포스트 프로세싱 파이프라인
   RenderPass → UnrealBloom → 커스텀 그레이딩 → FXAA → GammaCorrection

   커스텀 그레이딩 패스가 이 모듈의 핵심이다.
   · 필름 대비 / 채도 (lift-gamma-gain)
   · 청록-오렌지 톤 스플릿(그림자는 푸르게, 하이라이트는 따뜻하게)
   · 부드러운 비네팅 + 피격 붉은 비네트
   · 색수차(가장자리로 갈수록 R/B 분리) — 속도에 비례
   · 방사형 모션블러 10탭 — 속도감의 핵심
   · 필름 그레인 / 화면 색조 / 화이트 플래시 / 화면 흔들림

   ※ three.js r128 UMD 전역(THREE.*) 전용. ES 모듈 아님.
   ※ 필수 전역이 하나라도 없으면 fx.enabled=false 로 떨어지고
     fx.render() 는 renderer.render(scene,camera) 폴백으로 동작한다.

   ── 계약(NS.PostFX) ────────────────────────────────────────────────
   fx = SPIDER.PostFX.create(renderer, scene, camera, {mobile,width,height})
     fx.enabled            : false 로 두면 render() 가 원본 렌더로 폴백
     fx.render(dt)         : dt 는 초. 없거나 이상하면 0.016 으로 대체
     fx.setSize(w, h)      : ★ FX 체인만 리사이즈한다.
                             renderer.setSize / camera.aspect 는 호출측 책임.
                             (폴백 객체도 동일하게 동작 — 경로별 차이 없음)
     fx.setQuality(0|1|2)  : 인자가 없거나 이상하면 현재 품질 유지
     fx.setSpeed(0~1) / setDamage(0~1)        : 지속값(보간됨)
     fx.setPulse(0~1) / setShake(0~1)         : 임펄스(자동 감쇠, 0 이면 즉시 해제)
     fx.setTint(hex|Color|null, amount, key)  : key 별로 "쌓인다"(능력 중첩 대응)
     fx.clearTint(key?)    : key 생략 시 전체 색조 원복
     fx.resetTransient()   : 슈트 교체 / 리스폰 / 적 소멸 시 전 상태 원복
     fx.setCamera(cam) / fx.setScene(scn)     : stale 참조 갱신
     fx.dispose()          : GPU 자원 해제(이후 render 는 자동 폴백)
   ========================================================================= */
(function () {
  const NS = (window.SPIDER = window.SPIDER || {});

  /* ---------------------------------------------------------------- 유틸 */
  function clamp01(v) {
    v = +v;
    if (!(v > 0)) return 0;      // NaN/음수 방어
    return v > 1 ? 1 : v;
  }

  function damp(cur, target, rate, dt) {
    let k = rate * dt;
    if (!(k > 0)) return cur;    // NaN/음수 dt 방어
    if (k > 1) k = 1;
    const out = cur + (target - cur) * k;
    return out === out ? out : target;   // NaN 이면 목표값으로 스냅
  }

  // getPixelRatio() 가 0 / undefined / NaN 을 돌려주는 렌더러가 실제로 있다.
  // Math.max(NaN, 0.0001) === NaN 이라 그대로 두면 RT 크기가 NaN 이 된다.
  function safePR(renderer) {
    let pr = (renderer && typeof renderer.getPixelRatio === 'function')
      ? +renderer.getPixelRatio() : 1;
    if (!(pr > 0) || !isFinite(pr)) pr = 1;
    return pr > 4 ? 4 : pr;
  }

  function safeDim(v, fallback) {
    v = Math.round(+v);
    if (!(v > 0) || !isFinite(v)) v = fallback;
    return v < 1 ? 1 : (v > 16384 ? 16384 : v);
  }

  /* ------------------------------------------------- 커스텀 그레이딩 셰이더 */
  // WebGL1 / GLSL ES 1.0 — texture2D 만 사용, 루프 카운트는 const int 상수.
  //
  // ★ NaN 방어 원칙(이 프로젝트는 pow(음수, 소수) 로 화면 전체가 NaN 된 전력이 있다)
  //   · pow 의 밑은 반드시 max(x, eps) 로 0 과 음수를 모두 배제한다.
  //     (GLSL 스펙: x<0 이면 미정의, x==0 도 드라이버에 따라 NaN)
  //   · 샘플한 텍셀은 clamp 로 Inf 를 잘라낸다(블룸이 Inf 를 뱉으면 전파된다).
  //   · uTime 은 JS 쪽에서 200초마다 감아준다. 프래그먼트가 mediump 로
  //     떨어지는 모바일 GPU 에서 uTime*47.0 이 65504 를 넘으면 Inf → sin(Inf)=NaN.
  const GradeShader = {
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uSpeed: { value: 0 },          // 0~1 방사형 블러 + 색수차 세기
      uPulse: { value: 0 },          // 0~1 화이트 플래시
      uTint: { value: null },        // THREE.Color (create 에서 주입)
      uTintAmount: { value: 0 },
      uVignette: { value: 0.34 },
      uAberration: { value: 1 },
      uGrain: { value: 0.03 },
      uShake: { value: 0 },
      uDamage: { value: 0 },
      uResolution: { value: null }   // THREE.Vector2 (create 에서 주입)
    },

    vertexShader: [
      'varying vec2 vUv;',
      'void main() {',
      '  vUv = uv;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}'
    ].join('\n'),

    fragmentShader: [
      'uniform sampler2D tDiffuse;',
      'uniform float uTime;',
      'uniform float uSpeed;',
      'uniform float uPulse;',
      'uniform vec3  uTint;',
      'uniform float uTintAmount;',
      'uniform float uVignette;',
      'uniform float uAberration;',
      'uniform float uGrain;',
      'uniform float uShake;',
      'uniform float uDamage;',
      'uniform vec2  uResolution;',
      'varying vec2 vUv;',

      'const int TAPS = 10;',                     // 모션블러 탭 수(상수)
      'const float CEIL = 64.0;',                 // 샘플 상한 — Inf 차단
      'const float EPS  = 0.0001;',               // pow 밑 하한 — NaN 차단
      'const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);',
      'const vec3 LIFT  = vec3(0.006, 0.010, 0.022);',   // 그림자를 살짝 들어올리며 푸르게
      'const vec3 GAIN  = vec3(1.050, 1.014, 0.962);',   // 하이라이트는 따뜻하게
      'const vec3 GAMMA = vec3(0.985, 1.000, 1.022);',
      'const vec3 COOL  = vec3(0.40, 0.66, 1.00);',      // 그림자 청록
      'const vec3 WARM  = vec3(1.00, 0.82, 0.58);',      // 하이라이트 오렌지

      'float lum(vec3 c) { return dot(c, LUMA); }',

      // 이전 패스(블룸)가 Inf/음수를 흘려도 여기서 끊는다.
      'vec3 sampleTex(vec2 p) {',
      '  return clamp(texture2D(tDiffuse, clamp(p, vec2(0.0), vec2(1.0))).rgb, 0.0, CEIL);',
      '}',

      // 해시 기반 화이트노이즈(시간 기반 그레인용)
      'float hash12(vec2 p) {',
      '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
      '  p3 += dot(p3, p3.yzx + 33.33);',
      '  return fract((p3.x + p3.y) * p3.z);',
      '}',

      'void main() {',
      '  vec2 uv = vUv;',

      // ── 화면 흔들림: UV 자체를 미세하게 민다
      '  if (uShake > 0.0005) {',
      '    float t = uTime * 47.0;',
      '    vec2 sh = vec2(sin(t * 1.7) + 0.5 * sin(t * 3.9),',
      '                   cos(t * 2.3) + 0.5 * cos(t * 5.1));',
      '    uv = clamp(uv + sh * uShake * 0.0055, vec2(0.0), vec2(1.0));',
      '  }',

      '  vec2 cen = uv - 0.5;',
      '  float rad = length(cen);',
      '  float sp = clamp(uSpeed, 0.0, 1.0);',
      '  vec3 base = sampleTex(uv);',
      '  vec3 col = base;',

      // ── 방사형 모션블러: 중심에서 바깥으로 샘플을 끌어당긴다
      // base 가 f=0 탭이므로 루프는 1 부터. 총 TAPS 개.
      '  float blur = sp * sp * 0.090 * smoothstep(0.02, 0.55, rad);',
      '  if (blur > 0.0004) {',
      '    vec3 acc = base;',
      '    float wsum = 1.0;',
      '    for (int i = 1; i < TAPS; i++) {',
      '      float f = float(i) / float(TAPS - 1);',
      '      float w = 1.0 - f * 0.72;',
      '      vec2 suv = clamp(uv - cen * blur * f, vec2(0.0015), vec2(0.9985));',
      '      acc += sampleTex(suv) * w;',
      '      wsum += w;',
      '    }',
      '    col = acc / max(wsum, 0.0001);',
      '  }',

      // ── 색수차: 가장자리로 갈수록 R/B 채널을 반대로 민다
      // 블러 결과를 덮어쓰지 않도록 "차분"만 더한다(안 그러면 고속에서 R/B 블러가 사라짐)
      '  float ab = uAberration * (0.0012 + sp * 0.0062) * smoothstep(0.05, 0.78, rad);',
      '  if (ab > 0.00002) {',
      '    vec2 d = cen * ab;',
      '    float cr = sampleTex(clamp(uv - d, vec2(0.0015), vec2(0.9985))).r;',
      '    float cb = sampleTex(clamp(uv + d, vec2(0.0015), vec2(0.9985))).b;',
      '    col.r += (cr - base.r) * 0.85;',
      '    col.b += (cb - base.b) * 0.85;',
      '  }',

      // ── lift-gamma-gain 필름 그레이딩
      '  col = clamp(col, 0.0, CEIL);',
      '  col = LIFT + (GAIN - LIFT) * col;',
      // pow 밑을 EPS 로 바닥 고정 — 0/음수 진입 자체를 봉쇄
      '  col = pow(max(col, EPS), 1.0 / GAMMA);',

      // ── 청록-오렌지 톤 스플릿
      '  float l = clamp(lum(col), 0.0, 1.0);',
      '  float sw = (1.0 - l) * (1.0 - l);',
      '  float hw = pow(max(l, EPS), 1.6);',
      '  col = mix(col, col * COOL, sw * 0.155);',
      '  col = mix(col, col * WARM, hw * 0.130);',

      // ── 대비 + 채도
      '  col = (col - 0.5) * 1.075 + 0.5;',
      '  float g = lum(col);',
      '  col = mix(vec3(g), col, 1.14);',

      // ── 속도 가장자리 압착(빠를수록 화면 테두리가 어두워짐)
      '  col *= 1.0 - sp * 0.26 * smoothstep(0.26, 0.74, rad);',

      // ── 부드러운 비네팅
      // edge0 < edge1 로만 쓴다(역방향 smoothstep 은 GLSL 스펙상 미정의)
      '  float vig = 1.0 - smoothstep(0.16, 0.86, rad);',
      '  col *= mix(1.0, vig, clamp(uVignette, 0.0, 1.0));',

      // ── 피격 붉은 비네트
      '  if (uDamage > 0.001) {',
      '    float dmg = smoothstep(0.14, 0.64, rad) * clamp(uDamage, 0.0, 1.0);',
      '    col = mix(col, vec3(0.62, 0.035, 0.045), dmg * 0.78);',
      '    col *= 1.0 - dmg * 0.10;',
      '  }',

      // ── 화면 색조(능력/상태 표현)
      '  if (uTintAmount > 0.001) {',
      '    vec3 tinted = col * uTint;',
      '    tinted = mix(tinted, uTint * (0.22 + 0.78 * clamp(lum(col), 0.0, 1.0)), 0.35);',
      '    col = mix(col, tinted, clamp(uTintAmount, 0.0, 1.0));',
      '  }',

      // ── 필름 그레인(시간 기반, 어두운 곳에서 약간 더 보이게)
      '  if (uGrain > 0.0005) {',
      '    vec2 gp = vUv * max(uResolution, vec2(1.0)) + vec2(fract(uTime * 13.0) * 311.7,',
      '                                                        fract(uTime * 17.0) * 197.3);',
      '    float n = hash12(gp) - 0.5;',
      '    col += n * uGrain * (1.25 - 0.85 * clamp(lum(col), 0.0, 1.0));',
      '  }',

      // ── 화이트 플래시
      '  col = mix(col, vec3(1.0), clamp(uPulse, 0.0, 1.0));',

      // 출력 RT 는 8bit 라 어차피 0~1 로 잘린다. clamp 로 Inf 도 함께 제거.
      '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
      '}'
    ].join('\n')
  };

  /* ------------------------------------------------------------- 폴백 객체 */
  function makeFallback(renderer, scene, camera, why) {
    if (why) console.warn('[PostFX] 비활성 — ' + why);
    const noop = function () {};
    return {
      enabled: false,
      composer: null,
      bloomPass: null,
      gradePass: null,
      fxaaPass: null,
      gammaPass: null,
      renderPass: null,
      quality: 0,
      render: function () {
        if (renderer && scene && camera) renderer.render(scene, camera);
      },
      // ★ 정상 경로와 동일하게 FX 체인만 담당한다(여기선 담당할 게 없음).
      //   renderer.setSize / camera.aspect 는 호출측 책임 — 경로별로 다르게 굴면
      //   폴백일 때만 캔버스가 리사이즈되는 유령 버그가 난다.
      setSize: noop,
      setQuality: noop,
      setSpeed: noop,
      setPulse: noop,
      setTint: noop,
      setShake: noop,
      setDamage: noop,
      clearTint: noop,
      resetTransient: noop,
      setCamera: function (c) { if (c) camera = c; },
      setScene: function (s) { if (s) scene = s; },
      dispose: noop
    };
  }

  /* ----------------------------------------------------------------- 생성 */
  function create(renderer, scene, camera, opts) {
    opts = opts || {};
    const mobile = !!opts.mobile;

    // THREE 자체가 없으면 THREE[...] 접근에서 ReferenceError 로 죽는다.
    // 문서상 "전역이 없으면 폴백" 이므로 여기서 먼저 끊는다.
    if (typeof THREE === 'undefined' || !THREE) {
      return makeFallback(renderer, scene, camera, 'THREE 전역 없음');
    }
    if (!renderer || !scene || !camera) return makeFallback(renderer, scene, camera, '인자 누락');

    // 필수 전역 검사 — 하나라도 없으면 즉시 폴백
    const need = ['EffectComposer', 'RenderPass', 'ShaderPass', 'UnrealBloomPass',
      'FXAAShader', 'GammaCorrectionShader', 'CopyShader'];
    for (let i = 0; i < need.length; i++) {
      if (!THREE[need[i]]) return makeFallback(renderer, scene, camera, 'THREE.' + need[i] + ' 없음');
    }

    let composer = null, renderPass = null, bloomPass = null,
      gradePass = null, fxaaPass = null, gammaPass = null;

    // create 도중 실패하면 이미 만든 GPU 자원을 반드시 회수한다(누수 방지).
    function abort(why) {
      try {
        if (bloomPass && bloomPass.dispose) bloomPass.dispose();
        if (gradePass && gradePass.material) gradePass.material.dispose();
        if (fxaaPass && fxaaPass.material) fxaaPass.material.dispose();
        if (gammaPass && gammaPass.material) gammaPass.material.dispose();
        if (composer) {
          if (composer.copyPass && composer.copyPass.material) composer.copyPass.material.dispose();
          composer.renderTarget1.dispose();
          composer.renderTarget2.dispose();
        }
      } catch (e) { /* 회수 실패는 무시 */ }
      return makeFallback(renderer, scene, camera, why);
    }

    let w, h;
    try {
      const pr0 = safePR(renderer);
      // CSS 픽셀 기준 크기 — composer.setSize 가 원하는 단위다.
      w = safeDim(opts.width !== undefined ? opts.width : renderer.domElement.width / pr0, 1);
      h = safeDim(opts.height !== undefined ? opts.height : renderer.domElement.height / pr0, 1);

      composer = new THREE.EffectComposer(renderer);
      // 감마 이중 적용(화면이 뿌옇게 뜨는 현상) 방지 — 중간 버퍼는 반드시 선형
      composer.renderTarget1.texture.encoding = THREE.LinearEncoding;
      composer.renderTarget2.texture.encoding = THREE.LinearEncoding;

      renderPass = new THREE.RenderPass(scene, camera);
      composer.addPass(renderPass);

      bloomPass = new THREE.UnrealBloomPass(
        new THREE.Vector2(w * (mobile ? 0.5 : 1), h * (mobile ? 0.5 : 1)),
        mobile ? 0.35 : 0.50, 0.62, 0.80);
      composer.addPass(bloomPass);

      // 커스텀 그레이딩 (핵심)
      // ShaderPass 가 uniforms 를 clone 하므로 GradeShader 템플릿은 오염되지 않는다.
      gradePass = new THREE.ShaderPass(GradeShader);
      gradePass.uniforms.uTint.value = new THREE.Color(0xffffff);
      gradePass.uniforms.uResolution.value = new THREE.Vector2(w, h);
      composer.addPass(gradePass);

      fxaaPass = new THREE.ShaderPass(THREE.FXAAShader);
      composer.addPass(fxaaPass);

      // 감마 보정은 반드시 마지막
      gammaPass = new THREE.ShaderPass(THREE.GammaCorrectionShader);
      composer.addPass(gammaPass);
    } catch (e) {
      return abort('패스 생성 실패: ' + (e && e.message));
    }

    /* ------------------------------------------------------------ 내부 상태 */
    let time = 0;
    let quality = mobile ? 1 : 2;
    let sizeW = w, sizeH = h;
    // EffectComposer 생성자가 이미 렌더러의 픽셀비를 잡아뒀다. 여기서 같은 값으로
    // 초기화해두면 초기 setSize 가 setPixelRatio 를 다시 부르며 RT 를 두 번
    // 할당하는 낭비가 없어진다(픽셀비가 실제로 바뀔 때만 동기화).
    let lastPR = safePR(renderer);
    let disposed = false;
    let renderFails = 0;

    let speedTarget = 0, speedCur = 0;   // 부드럽게 따라감
    let damageTarget = 0, damageCur = 0; // 부드럽게 따라감
    let pulse = 0;                       // 임펄스(자동 감쇠)
    let shake = 0;                       // 임펄스(자동 감쇠)
    let tintAmount = 0;

    // 품질별 계수
    let kBloom = 1, kAberration = 1, kGrain = 0.03, kVignette = 0.62, kSpeedFx = 1;

    const u = gradePass.uniforms;

    // 매 프레임/매 호출 할당 금지 — 스코프에 한 번만 만들어 재사용한다.
    const _scratchColor = new THREE.Color(0xffffff);

    /* -------------------------------------------------------------- 크기 */
    // ★ FX 체인만 리사이즈한다. renderer.setSize / camera.aspect 는 호출측 책임.
    function setSize(cw, ch) {
      if (disposed) return;
      cw = safeDim(cw, sizeW);
      ch = safeDim(ch, sizeH);
      sizeW = cw; sizeH = ch;

      const pr = safePR(renderer);

      // renderer.setPixelRatio() 로 픽셀비가 바뀌었는데 composer 가 생성 시점 값을
      // 물고 있으면 RT 해상도가 캔버스와 어긋난다(품질 토글 시 실제로 발생).
      if (pr !== lastPR) {
        lastPR = pr;
        if (typeof composer.setPixelRatio === 'function') composer.setPixelRatio(pr);
      }

      composer.setSize(cw, ch);
      // setSize 이후에도 선형 인코딩 유지(감마 이중 적용 방지)
      composer.renderTarget1.texture.encoding = THREE.LinearEncoding;
      composer.renderTarget2.texture.encoding = THREE.LinearEncoding;

      const fu = fxaaPass && fxaaPass.material && fxaaPass.material.uniforms;
      if (fu && fu.resolution && fu.resolution.value) {
        fu.resolution.value.set(1 / (cw * pr), 1 / (ch * pr));
      }
      if (bloomPass) {
        // 모바일은 블룸만 절반 해상도로 계산해 부하를 줄인다
        const bs = (mobile || quality === 0) ? 0.5 : 1;
        if (bloomPass.resolution) bloomPass.resolution.set(cw * bs, ch * bs);
        bloomPass.setSize(Math.max(1, cw * bs * pr), Math.max(1, ch * bs * pr));
      }
      u.uResolution.value.set(cw * pr, ch * pr);
    }

    /* -------------------------------------------------------------- 품질 */
    function setQuality(level) {
      if (disposed) return;
      // setQuality() 를 인자 없이 부르면 undefined|0 === 0 이라
      // 조용히 "성능" 모드로 떨어지던 함정을 막는다.
      level = (level === undefined || level === null || isNaN(+level)) ? quality : (+level | 0);
      if (level < 0) level = 0;
      if (level > 2) level = 2;
      quality = level;

      if (level === 0) {              // 성능: 블룸/FXAA/그레인/색수차/모션블러 끔
        bloomPass.enabled = false;
        fxaaPass.enabled = false;
        kBloom = 0; kAberration = 0; kGrain = 0; kVignette = 0.5; kSpeedFx = 0;
      } else if (level === 1) {       // 보통
        bloomPass.enabled = true;
        fxaaPass.enabled = true;
        kBloom = mobile ? 0.35 : 0.42;
        kAberration = 0.6; kGrain = 0.02; kVignette = 0.30; kSpeedFx = 0.7;
      } else {                        // 최고
        bloomPass.enabled = true;
        fxaaPass.enabled = true;
        kBloom = mobile ? 0.35 : 0.50;
        kAberration = 1.0; kGrain = 0.03; kVignette = 0.34; kSpeedFx = 1.0;
      }
      if (level > 0) bloomPass.strength = kBloom;
      u.uAberration.value = kAberration;
      u.uGrain.value = kGrain;
      u.uVignette.value = kVignette;
      setSize(sizeW, sizeH);          // 블룸 해상도 재적용
    }

    /* ------------------------------------------------------------ 세터들 */
    // 속도감(0~1). 매 프레임 호출해도 됨 — 내부에서 부드럽게 보간한다.
    function setSpeed(v) { speedTarget = clamp01(v); }

    // 화이트 플래시. 임펄스 — 한 번 1 을 주면 약 0.3초에 걸쳐 스스로 사라진다.
    // 0 을 주면 즉시 해제.
    function setPulse(v) {
      v = clamp01(v);
      pulse = v <= 0 ? 0 : Math.max(pulse, v);
    }

    // 화면 흔들림. 임펄스 — setPulse 와 같은 규칙(약 0.4초 감쇠).
    function setShake(v) {
      v = clamp01(v);
      shake = v <= 0 ? 0 : Math.max(shake, v);
    }

    // 피격 붉은 비네트(0~1). 매 프레임 hp 로 갱신해도 됨 — 보간된다.
    function setDamage(v) { damageTarget = clamp01(v); }

    /* --------------------------------------------------------- 화면 색조
       ★ 원복 보장 / 능력 중첩
       예전 구현은 색조가 전역 단일 슬롯이라, 능력 A(스파이더 센스)와
       능력 B(분노)가 겹친 뒤 B 가 끝나며 setTint(null) 을 부르면
       A 의 색조까지 같이 날아가고 다시는 돌아오지 않았다.
       (setTint 는 매 프레임 호출이 아니라 상태 세터라서 자가 복구가 없다.)
       → key 별 레이어 스택으로 바꿔, 위에 쌓인 게 빠지면 아래가 그대로 복원된다.
       key 를 안 주면 예전과 동일하게 단일 '__default' 슬롯을 쓴다.        */
    const tintLayers = [];   // [{ key, hex, amount }] — 마지막 항목이 화면에 반영

    function toHex(v) {
      if (typeof v === 'number' && isFinite(v)) return v | 0;
      _scratchColor.setHex(0xffffff);   // set 실패 시 이전 값이 새는 것 방지
      try {
        if (v && v.isColor) _scratchColor.copy(v);
        else _scratchColor.set(v);
      } catch (e) { _scratchColor.setHex(0xffffff); }
      return _scratchColor.getHex();
    }

    function tintIndex(key) {
      for (let i = 0; i < tintLayers.length; i++) {
        if (tintLayers[i].key === key) return i;
      }
      return -1;
    }

    function applyTopTint() {
      if (tintLayers.length === 0) { tintAmount = 0; return; }
      const top = tintLayers[tintLayers.length - 1];
      u.uTint.value.setHex(top.hex);
      tintAmount = top.amount;
    }

    function setTint(hexOrNull, amount, key) {
      if (disposed) return;
      key = (key === undefined || key === null) ? '__default' : String(key);
      const amt = clamp01(amount === undefined ? 1 : amount);
      const idx = tintIndex(key);

      // 해제: 해당 레이어만 제거(순회 중 splice 아님 — 인덱스 확정 후 1회)
      if (hexOrNull === null || hexOrNull === undefined || amt <= 0) {
        if (idx >= 0) tintLayers.splice(idx, 1);
        applyTopTint();
        return;
      }

      const hex = toHex(hexOrNull);
      if (idx >= 0) {
        // 기존 레이어 갱신 — 맨 위로 올려 "가장 최근 능력이 보이게"
        const layer = tintLayers[idx];
        layer.hex = hex; layer.amount = amt;
        if (idx !== tintLayers.length - 1) {
          tintLayers.splice(idx, 1);
          tintLayers.push(layer);
        }
      } else {
        tintLayers.push({ key: key, hex: hex, amount: amt });
        // 해제 호출을 빼먹은 능력이 무한히 쌓이는 것 방지
        if (tintLayers.length > 8) tintLayers.shift();
      }
      applyTopTint();
    }

    // key 생략 시 전체 원복. 슈트 교체 / 적 전멸 / 능력 일괄 종료용.
    function clearTint(key) {
      if (key === undefined || key === null) tintLayers.length = 0;
      else {
        const idx = tintIndex(String(key));
        if (idx >= 0) tintLayers.splice(idx, 1);
      }
      applyTopTint();
    }

    // 슈트 교체 / 리스폰 / 컷신 진입 시 임시 상태를 전부 원상복구한다.
    function resetTransient() {
      speedTarget = speedCur = 0;
      damageTarget = damageCur = 0;
      pulse = 0; shake = 0;
      tintLayers.length = 0;
      tintAmount = 0;
      u.uTint.value.setHex(0xffffff);
      u.uSpeed.value = 0; u.uPulse.value = 0; u.uShake.value = 0;
      u.uDamage.value = 0; u.uTintAmount.value = 0;
    }

    /* ------------------------------------------- stale 참조 갱신(카메라/씬) */
    // player.rig 처럼 카메라/씬도 교체된다. 폐쇄된 closure 값과 renderPass 필드
    // 두 곳을 반드시 함께 갱신해야 폴백 렌더까지 새 참조를 쓴다.
    function setCamera(cam) {
      if (!cam) return;
      camera = cam;
      if (renderPass) renderPass.camera = cam;
    }

    function setScene(scn) {
      if (!scn) return;
      scene = scn;
      if (renderPass) renderPass.scene = scn;
    }

    /* -------------------------------------------------------------- 렌더 */
    function render(dt) {
      // 통합 측에서 fx.enabled = false 로 끄거나 dispose 된 뒤엔 원본 렌더로 폴백
      if (disposed || !fx.enabled) { renderer.render(scene, camera); return; }
      dt = +dt;
      if (!(dt > 0) || dt > 0.25) dt = 0.016;   // NaN/스파이크 방어

      // ★ 200초에서 감는다. 셰이더가 uTime*47.0 을 쓰는데, 프래그먼트 정밀도가
      //   mediump 로 떨어지는 모바일 GPU 에서 65504 를 넘으면 Inf → sin(Inf)=NaN.
      //   예전 임계값(100000)은 4.7e6 이라 화면 전체가 NaN 이 됐다.
      time += dt;
      if (time > 200) time -= 200;

      // 임펄스 감쇠
      if (pulse > 0) { pulse -= dt * 3.4; if (pulse < 0) pulse = 0; }
      if (shake > 0) { shake -= dt * 2.6; if (shake < 0) shake = 0; }

      // 부드러운 추종
      speedCur = damp(speedCur, speedTarget, 6.5, dt);
      damageCur = damp(damageCur, damageTarget, 7.0, dt);

      u.uTime.value = time;
      u.uSpeed.value = speedCur * kSpeedFx;
      u.uPulse.value = pulse;
      u.uShake.value = shake;
      u.uDamage.value = damageCur;
      u.uTintAmount.value = tintAmount;

      // 컨텍스트 소실 / 셰이더 링크 실패로 composer 가 던져도 게임은 계속 그린다.
      try {
        composer.render(dt);
        renderFails = 0;
      } catch (e) {
        if (renderFails++ < 3) console.error('[PostFX] composer.render 실패', e);
        if (renderFails >= 8) {
          fx.enabled = false;
          console.warn('[PostFX] 반복 실패로 영구 폴백 전환');
        }
        renderer.render(scene, camera);
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      fx.enabled = false;   // dispose 후 render() 가 죽은 RT 를 건드리지 않게
      try {
        if (bloomPass && bloomPass.dispose) bloomPass.dispose();
        if (gradePass && gradePass.material) gradePass.material.dispose();
        if (fxaaPass && fxaaPass.material) fxaaPass.material.dispose();
        if (gammaPass && gammaPass.material) gammaPass.material.dispose();
        if (composer) {
          if (composer.copyPass && composer.copyPass.material) composer.copyPass.material.dispose();
          composer.renderTarget1.dispose();
          composer.renderTarget2.dispose();
        }
        // ※ fsQuad.dispose() 는 부르지 않는다 — r128 FullScreenQuad 는 모듈 전역
        //   _geometry 를 공유하므로 하나만 dispose 해도 모든 패스가 깨진다.
      } catch (e) { /* 무시 */ }
    }

    const fx = {
      enabled: true,
      composer: composer,
      renderPass: renderPass,
      bloomPass: bloomPass,
      gradePass: gradePass,
      fxaaPass: fxaaPass,
      gammaPass: gammaPass,
      get quality() { return quality; },
      render: render,
      setSize: setSize,
      setQuality: setQuality,
      setSpeed: setSpeed,
      setPulse: setPulse,
      setTint: setTint,
      clearTint: clearTint,
      resetTransient: resetTransient,
      setShake: setShake,
      setDamage: setDamage,
      setCamera: setCamera,
      setScene: setScene,
      dispose: dispose
    };

    // sizeW/sizeH 는 이미 실제 크기라 setQuality 안의 setSize 한 번으로 끝난다.
    // (예전엔 1x1 로 RT 를 만들었다가 곧바로 재할당하는 낭비가 있었다.)
    setQuality(quality);
    return fx;
  }

  NS.PostFX = { create: create };
})();
