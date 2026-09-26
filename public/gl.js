// WebGL2 renderer. Every drawn cell is a glowing point (a small shaded sphere when you zoom in),
// the published connections are faint lines that light up when the cell sending on them fires,
// sparks run from sender to receiver, and a bloom pass makes it glow. Out-of-focus cells blur
// like a macro lens. Nothing here changes what the worm does; it only draws the activity it's given.

const TW = 64;   // data textures are TW wide

export const KIND_INDEX = { eye: 0, touch: 1, sn: 2, in: 3, mn: 4, mus: 5, cil: 6, other: 7 };

const COMMON = `#version 300 es
precision highp float; precision highp int;
uniform highp sampler2D u_pos; uniform mediump sampler2D u_act; uniform mediump sampler2D u_col; uniform mediump sampler2D u_hl;
uniform mat4 u_vp; uniform float u_bend, u_st, u_time, u_px, u_focusD, u_dof, u_kind, u_kindK;
ivec2 tc(int i) { return ivec2(i % ${TW}, i / ${TW}); }
// the data's z axis points to the belly, which with x = right and y = head is a mirror-image frame;
// drawing -z (towards the back) makes it right-handed, so the larva isn't shown mirrored
vec3 cellPos(int i) {
  vec3 p = texelFetch(u_pos, tc(i), 0).xyz;
  vec3 q = vec3(p.x * (1.0 + 0.12 * u_st), p.y * (1.0 - 0.07 * u_st), -p.z * (1.0 + 0.12 * u_st));
  float s = (1.0 - p.y) * 0.5;
  q.x += u_bend * 0.42 * s * s; q.y -= abs(u_bend) * 0.06 * s * s;
  return q;
}
float act(int i) { return texelFetch(u_act, tc(i), 0).r; }
vec4 col(int i) { return texelFetch(u_col, tc(i), 0); }
float hl(int i) { return texelFetch(u_hl, tc(i), 0).r; }
// how far from the focal plane, 0 = sharp .. 1 = fully blurred
float coc(float w) { return clamp(abs(w - u_focusD) * u_dof, 0.0, 1.0); }
// story mode: one kind of cell is lit up, the rest dim a little
float kindGain(float kind) { return u_kind < 0.0 ? 1.0 : (abs(kind - u_kind) < 0.5 ? 1.0 + 1.6 * u_kindK : 1.0 - 0.55 * u_kindK); }
`;

const CELL_VS = COMMON + `
in float a_idx; uniform float u_hover, u_hasFocus;
out vec3 v_col; out float v_i; out float v_core; out float v_ring; out float v_blur;
void main() {
  int i = int(a_idx); vec4 c = col(i); float a = act(i); float h = hl(i);
  gl_Position = u_vp * vec4(cellPos(i), 1.0);
  float kind = c.a * 255.0;
  float base = kind < 0.5 ? 0.030 : kind < 1.5 ? 0.022 : 0.017;
  float b = coc(gl_Position.w);
  float px = (base + a * 0.042 + h * 0.012) * u_px / gl_Position.w;
  gl_PointSize = clamp(px * (1.0 + 2.2 * b), 1.5, 128.0);
  float rest = kind < 0.5 ? 0.55 : kind < 1.5 ? 0.34 : 0.16;
  // when one cell is being traced, everything that isn't wired to it steps back
  float dim = u_hasFocus > 0.5 ? (h > 0.0 ? 1.0 : 0.28) : 1.0;
  v_col = c.rgb;
  v_i = (rest + a * 2.5 + h * 1.4) * kindGain(kind) * dim / (1.0 + 2.6 * b);
  v_core = a; v_blur = b;
  v_ring = abs(a_idx - u_hover) < 0.5 ? 1.0 : 0.0;
}`;
const CELL_FS = `#version 300 es
precision mediump float;
in vec3 v_col; in float v_i; in float v_core; in float v_ring; in float v_blur; out vec4 o;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0; float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float sharp = mix(11.0, 2.2, v_blur);
  float core = exp(-r2 * sharp), halo = exp(-r2 * 3.0) * 0.3;
  // a small lit sphere: visible when zoomed in, it gives the cells a body
  vec3 n = vec3(d.x, -d.y, sqrt(max(0.0, 1.0 - r2)));
  float shade = 0.55 + 0.45 * max(dot(n, normalize(vec3(-0.4, 0.6, 0.7))), 0.0) + 0.35 * pow(1.0 - n.z, 3.0);
  vec3 c = mix(v_col * mix(shade, 1.0, v_blur), vec3(1.0), clamp(v_core * 1.3, 0.0, 1.0) * core);
  float r = sqrt(r2);
  float ring = v_ring * (smoothstep(0.6, 0.7, r) - smoothstep(0.8, 0.95, r)) * 1.8;
  o = vec4(c * v_i * (core + halo) + vec3(ring), 1.0);
}`;

const HAZE_VS = COMMON + `
in float a_idx; uniform float u_haze;
out vec3 v_c;
void main() {
  int i = int(a_idx); vec4 c = col(i);
  gl_Position = u_vp * vec4(cellPos(i), 1.0);
  gl_PointSize = clamp(0.085 * u_px / gl_Position.w, 2.0, 140.0);
  v_c = mix(vec3(0.35, 0.55, 0.75), c.rgb, 0.35) * (u_haze + act(i) * 0.05);
}`;
const HAZE_FS = `#version 300 es
precision mediump float; in vec3 v_c; out vec4 o;
void main() { vec2 d = gl_PointCoord * 2.0 - 1.0; float r2 = dot(d, d); if (r2 > 1.0) discard; o = vec4(v_c * (1.0 - r2) * (1.0 - r2), 1.0); }`;

const EDGE_VS = COMMON + `
in float a_cell; in float a_pre; in float a_post; in float a_w; uniform float u_edge, u_web, u_focusIdx;
out vec3 v_c;
void main() {
  int i = int(a_cell); float a = act(int(a_pre));
  gl_Position = u_vp * vec4(cellPos(i), 1.0);
  float w = clamp(a_w / 6.0, 0.2, 1.0);
  float k = (smoothstep(0.06, 0.55, a) * w * u_edge + u_web * w) / (1.0 + 2.0 * coc(gl_Position.w));
  vec3 c = mix(vec3(0.5, 0.7, 1.0), col(i).rgb, 0.4) * k;
  // tracing: this cell's outputs in amber, its inputs in cyan
  if (u_focusIdx >= 0.0) {
    bool outE = abs(a_pre - u_focusIdx) < 0.5, inE = abs(a_post - u_focusIdx) < 0.5;
    c = outE ? vec3(1.0, 0.72, 0.3) * (0.35 + 0.5 * w) : inE ? vec3(0.34, 0.9, 0.82) * (0.35 + 0.5 * w) : c * 0.25;
  }
  v_c = c;
}`;
const FLAT_FS = `#version 300 es
precision mediump float; in vec3 v_c; out vec4 o; void main() { o = vec4(v_c, 1.0); }`;

const SPARK_VS = COMMON + `
in float a_pre; in float a_post; in float a_w; in float a_seed;
out vec3 v_c;
void main() {
  int pre = int(a_pre); float a = act(pre);
  float on = smoothstep(0.14, 0.65, a) * clamp(a_w / 4.0, 0.35, 1.0);
  float t = fract(u_time * (0.55 + a_seed * 0.9) + a_seed * 7.13);
  gl_Position = u_vp * vec4(mix(cellPos(pre), cellPos(int(a_post)), t), 1.0);
  float b = coc(gl_Position.w);
  gl_PointSize = on > 0.004 ? clamp(0.016 * u_px / gl_Position.w * (1.0 + 1.5 * b), 1.0, 16.0) : 0.0;
  v_c = mix(col(pre).rgb, vec3(1.0), 0.55) * on * 1.8 * (1.0 - 0.6 * t) / (1.0 + 2.0 * b);
}`;
const SPARK_FS = `#version 300 es
precision mediump float; in vec3 v_c; out vec4 o;
void main() { vec2 d = gl_PointCoord * 2.0 - 1.0; float r2 = dot(d, d); if (r2 > 1.0) discard; o = vec4(v_c * exp(-r2 * 4.0), 1.0); }`;

const SNOW_VS = `#version 300 es
precision highp float;
in vec4 a_p; uniform mat4 u_vp; uniform float u_time, u_px;
out float v_a;
void main() {
  vec3 p = a_p.xyz + vec3(sin(u_time * 0.07 + a_p.w * 6.0) * 0.25, mod(u_time * 0.018 * (0.5 + a_p.w) + a_p.y + 3.0, 6.0) - 3.0 - a_p.y, cos(u_time * 0.05 + a_p.w * 9.0) * 0.25);
  gl_Position = u_vp * vec4(p, 1.0);
  gl_PointSize = clamp(0.03 * u_px / gl_Position.w, 1.0, 6.0);
  v_a = 0.05 + 0.07 * a_p.w;
}`;
const SNOW_FS = `#version 300 es
precision mediump float; in float v_a; out vec4 o;
void main() { vec2 d = gl_PointCoord * 2.0 - 1.0; float r2 = dot(d, d); if (r2 > 1.0) discard; o = vec4(vec3(0.55, 0.75, 0.95) * v_a * (1.0 - r2), 1.0); }`;

// the real shapes of the traced cells (neurites, muscle fibres), lit by each cell's activity
const MORPH_VS = COMMON + `
in vec3 a_p; in float a_cell; uniform float u_morph, u_hasFocus;
out vec3 v_c;
vec3 bendAt(vec3 p) {
  vec3 q = vec3(p.x * (1.0 + 0.12 * u_st), p.y * (1.0 - 0.07 * u_st), -p.z * (1.0 + 0.12 * u_st));
  float s = (1.0 - p.y) * 0.5;
  q.x += u_bend * 0.42 * s * s; q.y -= abs(u_bend) * 0.06 * s * s;
  return q;
}
void main() {
  gl_Position = u_vp * vec4(bendAt(a_p), 1.0);
  float b = coc(gl_Position.w);
  vec3 c = vec3(0.45, 0.6, 0.75); float a = 0.0, h = 0.0, kind = 7.0;
  if (a_cell >= 0.0) { int i = int(a_cell); vec4 cc = col(i); c = cc.rgb; kind = cc.a * 255.0; a = act(i); h = hl(i); }
  float dim = u_hasFocus > 0.5 ? (h > 0.0 ? 1.4 : 0.2) : 1.0;
  v_c = mix(c, vec3(1.0), a * 0.5) * (0.085 + a * 1.4 + h * 0.3) * kindGain(kind) * dim * u_morph / (1.0 + 2.2 * b);
}`;
const SHELL_VS = COMMON + `
in vec3 a_p; in vec3 a_n; uniform vec3 u_eye;
out float v_f;
void main() {
  vec3 q = vec3(a_p.x * (1.0 + 0.12 * u_st), a_p.y * (1.0 - 0.07 * u_st), -a_p.z * (1.0 + 0.12 * u_st));
  float s = (1.0 - a_p.y) * 0.5;
  q.x += u_bend * 0.42 * s * s; q.y -= abs(u_bend) * 0.06 * s * s;
  gl_Position = u_vp * vec4(q, 1.0);
  vec3 v = normalize(u_eye - q);
  v_f = pow(1.0 - abs(dot(normalize(vec3(a_n.xy, -a_n.z)), v)), 2.6);
}`;
const SHELL_FS = `#version 300 es
precision mediump float; in float v_f; uniform float u_shell; uniform vec3 u_tint; out vec4 o;
void main() { o = vec4(u_tint * v_f * u_shell, 1.0); }`;

const QUAD_VS = `#version 300 es
out vec2 v_uv;
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); v_uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
// dual-filter (Kawase) blur: cheap, wide, smooth
const DOWN_FS = `#version 300 es
precision mediump float; uniform sampler2D u_src; uniform vec2 u_texel; uniform float u_thresh; in vec2 v_uv; out vec4 o;
vec3 s(vec2 uv) { return max(texture(u_src, uv).rgb - u_thresh, 0.0); }
void main() {
  vec2 h = u_texel * 0.5;
  vec3 c = s(v_uv) * 4.0 + s(v_uv - h) + s(v_uv + h) + s(v_uv + vec2(h.x, -h.y)) + s(v_uv - vec2(h.x, -h.y));
  o = vec4(c / 8.0, 1.0);
}`;
const UP_FS = `#version 300 es
precision mediump float; uniform sampler2D u_src; uniform vec2 u_texel; in vec2 v_uv; out vec4 o;
void main() {
  vec2 h = u_texel * 0.5; vec3 c = vec3(0.0);
  c += texture(u_src, v_uv + vec2(-h.x * 2.0, 0.0)).rgb + texture(u_src, v_uv + vec2(h.x * 2.0, 0.0)).rgb;
  c += texture(u_src, v_uv + vec2(0.0, -h.y * 2.0)).rgb + texture(u_src, v_uv + vec2(0.0, h.y * 2.0)).rgb;
  c += (texture(u_src, v_uv + vec2(-h.x, h.y)).rgb + texture(u_src, v_uv + vec2(h.x, h.y)).rgb
      + texture(u_src, v_uv + vec2(-h.x, -h.y)).rgb + texture(u_src, v_uv + vec2(h.x, -h.y)).rgb) * 2.0;
  o = vec4(c / 12.0, 1.0);
}`;
const COMPOSITE_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_scene, u_bloom; uniform float u_bloomK, u_shock, u_time, u_exposure; uniform vec2 u_res, u_center;
in vec2 v_uv; out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 uv = v_uv, dir = uv - u_center;
  float ca = 0.0012 + u_shock * 0.007;
  vec3 sc = vec3(texture(u_scene, uv - dir * ca).r, texture(u_scene, uv).g, texture(u_scene, uv + dir * ca).b);
  vec3 bl = texture(u_bloom, uv).rgb;
  float r = length(dir * vec2(u_res.x / u_res.y, 1.0));
  vec3 bg = mix(vec3(0.046, 0.094, 0.132), vec3(0.010, 0.019, 0.031), smoothstep(0.0, 0.95, r));
  vec3 c = bg + sc + bl * u_bloomK;
  c = 1.0 - exp(-c * u_exposure * (1.0 + u_shock * 0.4));
  c *= 1.0 - smoothstep(0.6, 1.35, r) * 0.6;
  c += (hash(gl_FragCoord.xy + fract(u_time) * 97.0) - 0.5) * 0.016;
  o = vec4(pow(max(c, 0.0), vec3(0.95)), 1.0);
}`;

/* ---------- small matrix helpers (column-major) ---------- */
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
function lookAt(e, t, u) {
  let zx = e[0] - t[0], zy = e[1] - t[1], zz = e[2] - t[2];
  let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
  let xx = u[1] * zz - u[2] * zy, xy = u[2] * zx - u[0] * zz, xz = u[0] * zy - u[1] * zx;
  l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
}
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
  }
  return o;
}

/** The same body deformation the shader applies, for picking and overlays. */
export function deform(p, bend, st) {
  let x = p[0] * (1 + 0.12 * st), y = p[1] * (1 - 0.07 * st); const z = -p[2] * (1 + 0.12 * st);   // see cellPos: drawn right-handed
  const s = (1 - p[1]) / 2; x += bend * 0.42 * s * s; y -= Math.abs(bend) * 0.06 * s * s;
  return [x, y, z];
}

/**
 * Camera: orbit (yaw, pitch) at `dist` around a point on the body axis at height `ty`,
 * with the picture shifted by (ox, oy) in screen units so the worm can sit beside a panel.
 */
export function viewProj(cam, aspect) {
  const ty = cam.ty ?? -0.16, cp = Math.cos(cam.pitch);
  const t = [0, ty, 0], eye = [Math.sin(cam.yaw) * cp * cam.dist, ty + Math.sin(cam.pitch) * cam.dist, Math.cos(cam.yaw) * cp * cam.dist];
  const vp = mul(perspective(cam.fov || 0.55, aspect, 0.05, 40), lookAt(eye, t, [0, 1, 0]));
  if (cam.ox || cam.oy) { for (let c = 0; c < 4; c++) { vp[c * 4] += (cam.ox || 0) * vp[c * 4 + 3]; vp[c * 4 + 1] += (cam.oy || 0) * vp[c * 4 + 3]; } }
  return vp;
}

/** Project a world point with a view-projection matrix to [x, y] in 0..1 screen units and w (depth). */
export function project(vp, x, y, z) {
  const w = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
  return [((vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / w) * 0.5 + 0.5, 0.5 - ((vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / w) * 0.5, w];
}

export function createGLRenderer(canvas, { D, colors, kinds, quality = 'high' }) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  if (!gl) return null;
  const N = D.n.length, TH = Math.ceil(N / TW);
  const hdr = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  const drawn = []; for (let i = 0; i < N; i++) if (D.n[i][5]) drawn.push(i);

  function program(vs, fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let k = 0; k < nu; k++) { const n = gl.getActiveUniform(p, k).name; u[n] = gl.getUniformLocation(p, n); }
    return { p, u };
  }
  function vao(attrs) {
    const v = gl.createVertexArray(); gl.bindVertexArray(v);
    for (const [prog, name, data, size] of attrs) {
      const loc = gl.getAttribLocation(prog.p, name); if (loc < 0) continue;
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null); return v;
  }
  function tex(internal, format, type, w, h, data, filter = gl.NEAREST) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  const P = {
    cell: program(CELL_VS, CELL_FS), haze: program(HAZE_VS, HAZE_FS), edge: program(EDGE_VS, FLAT_FS), spark: program(SPARK_VS, SPARK_FS),
    snow: program(SNOW_VS, SNOW_FS), down: program(QUAD_VS, DOWN_FS), up: program(QUAD_VS, UP_FS), comp: program(QUAD_VS, COMPOSITE_FS),
    morph: program(MORPH_VS, FLAT_FS), shell: program(SHELL_VS, SHELL_FS),
  };

  // data textures: positions, colour + kind, activity, highlight
  const posData = new Float32Array(TW * TH * 4), colData = new Uint8Array(TW * TH * 4);
  for (let i = 0; i < N; i++) {
    const p = D.n[i][5] || [0, 0, 0]; posData.set([p[0], p[1], p[2], 1], i * 4);
    const c = colors[kinds[i]]; colData.set([c[0], c[1], c[2], KIND_INDEX[kinds[i]] ?? 7], i * 4);
  }
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const posTex = tex(gl.RGBA32F, gl.RGBA, gl.FLOAT, TW, TH, posData);
  const colTex = tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, TW, TH, colData);
  const actData = new Uint8Array(TW * TH), hlData = new Uint8Array(TW * TH);
  const actTex = tex(gl.R8, gl.RED, gl.UNSIGNED_BYTE, TW, TH, actData);
  const hlTex = tex(gl.R8, gl.RED, gl.UNSIGNED_BYTE, TW, TH, hlData);

  // geometry
  const drawnF = Float32Array.from(drawn);
  const cellVao = vao([[P.cell, 'a_idx', drawnF, 1]]);
  const hazeVao = vao([[P.haze, 'a_idx', drawnF, 1]]);
  const ed = []; for (let k = 0; k < D.e.length; k += 3) if (D.n[D.e[k]][5] && D.n[D.e[k + 1]][5]) ed.push([D.e[k], D.e[k + 1], D.e[k + 2]]);
  const E = ed.length;
  const lc = new Float32Array(E * 2), lp = new Float32Array(E * 2), lq = new Float32Array(E * 2), lw = new Float32Array(E * 2);
  const sp = new Float32Array(E), sq = new Float32Array(E), sw = new Float32Array(E), ss = new Float32Array(E);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  ed.forEach(([a, b, w], k) => {
    lc[k * 2] = a; lc[k * 2 + 1] = b; lp[k * 2] = a; lp[k * 2 + 1] = a; lq[k * 2] = b; lq[k * 2 + 1] = b; lw[k * 2] = w; lw[k * 2 + 1] = w;
    sp[k] = a; sq[k] = b; sw[k] = w; ss[k] = rnd();
  });
  const edgeVao = vao([[P.edge, 'a_cell', lc, 1], [P.edge, 'a_pre', lp, 1], [P.edge, 'a_post', lq, 1], [P.edge, 'a_w', lw, 1]]);
  const sparkVao = vao([[P.spark, 'a_pre', sp, 1], [P.spark, 'a_post', sq, 1], [P.spark, 'a_w', sw, 1], [P.spark, 'a_seed', ss, 1]]);
  const SNOW = quality === 'low' ? 400 : 900, snow = new Float32Array(SNOW * 4);
  for (let k = 0; k < SNOW; k++) snow.set([(rnd() - 0.5) * 7, (rnd() - 0.5) * 6, (rnd() - 0.5) * 7, rnd()], k * 4);
  const snowVao = vao([[P.snow, 'a_p', snow, 4]]);
  const quadVao = gl.createVertexArray();

  // partners of every cell, for tracing
  const partners = Array.from({ length: N }, () => []);
  for (let k = 0; k < D.e.length; k += 3) { partners[D.e[k]].push(D.e[k + 1]); partners[D.e[k + 1]].push(D.e[k]); }
  let focusIdx = -1;
  function setFocus(i) {
    if (i === focusIdx) return;
    hlData.fill(0);
    if (i >= 0) { for (const j of partners[i]) hlData[j] = 150; hlData[i] = 255; }
    focusIdx = i;
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, hlTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TW, TH, gl.RED, gl.UNSIGNED_BYTE, hlData);
  }

  // the larva's anatomy, loaded later: {points: Float32Array xyz, cells: Float32Array, indices: Uint32Array,
  // outline: {positions, normals, indices}}
  let morph = null, shell = null, yolk = null;
  function setMorph(m) {
    const buf = (data, target = gl.ARRAY_BUFFER) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; };
    const attr = (prog, name, b, size) => { const loc = gl.getAttribLocation(prog.p, name); if (loc < 0) return; gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); };
    let v = gl.createVertexArray(); gl.bindVertexArray(v);
    attr(P.morph, 'a_p', buf(m.points), 3); attr(P.morph, 'a_cell', buf(m.cells), 1);
    buf(m.indices, gl.ELEMENT_ARRAY_BUFFER);
    gl.bindVertexArray(null);
    morph = { vao: v, count: m.indices.length };
    const meshVao = (mm) => {
      if (!mm) return null;
      const vv = gl.createVertexArray(); gl.bindVertexArray(vv);
      attr(P.shell, 'a_p', buf(mm.positions), 3); attr(P.shell, 'a_n', buf(mm.normals), 3);
      buf(mm.indices, gl.ELEMENT_ARRAY_BUFFER);
      gl.bindVertexArray(null);
      return { vao: vv, count: mm.indices.length, type: mm.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
    };
    shell = meshVao(m.outline);
    yolk = meshVao(m.yolk);
  }

  // render targets: scene + bloom mip chain
  let W = 0, H = 0, scene = null, mips = [];
  function target(w, h) {
    const t = hdr ? tex(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, w, h, null, gl.LINEAR) : tex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, w, h, null, gl.LINEAR);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, f, w, h };
  }
  function freeTarget(x) { if (x) { gl.deleteTexture(x.t); gl.deleteFramebuffer(x.f); } }
  function resize(w, h) {
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    if (w === W && h === H) return;
    W = w; H = h; canvas.width = w; canvas.height = h;
    freeTarget(scene); mips.forEach(freeTarget);
    scene = target(w, h); mips = [];
    let mw = w, mh = h;
    for (let k = 0; k < 5; k++) { mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1); mips.push(target(mw, mh)); }
  }

  function bindData(prog, st) {
    gl.useProgram(prog.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, posTex); gl.uniform1i(prog.u.u_pos, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, actTex); gl.uniform1i(prog.u.u_act, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, colTex); gl.uniform1i(prog.u.u_col, 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, hlTex); gl.uniform1i(prog.u.u_hl, 3);
    gl.uniformMatrix4fv(prog.u.u_vp, false, st.vp);
    gl.uniform1f(prog.u.u_bend, st.bend); gl.uniform1f(prog.u.u_st, st.st); gl.uniform1f(prog.u.u_time, st.time); gl.uniform1f(prog.u.u_px, st.px);
    gl.uniform1f(prog.u.u_focusD, st.focusD); gl.uniform1f(prog.u.u_dof, st.dof);
    gl.uniform1f(prog.u.u_kind, st.kind); gl.uniform1f(prog.u.u_kindK, st.kindK);
  }
  function pass(prog, src, dst, extra) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.f : null);
    gl.viewport(0, 0, dst ? dst.w : W, dst ? dst.h : H);
    gl.useProgram(prog.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.t); gl.uniform1i(prog.u.u_src, 0);
    gl.uniform2f(prog.u.u_texel, 1 / src.w, 1 / src.h);
    if (extra) extra();
    gl.bindVertexArray(quadVao); gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  let vp = null;
  /**
   * @param {{act: Uint8Array, cam, bend, st, shock, time, hover?, focus?, kind?, kindK?, exposure?, bloom?, web?, dof?}} s
   */
  function frame(s) {
    if (!scene || gl.isContextLost()) return;
    actData.set(s.act.subarray(0, N));
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, actTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TW, TH, gl.RED, gl.UNSIGNED_BYTE, actData);
    setFocus(s.focus ?? -1);
    vp = viewProj(s.cam, W / H);
    const st = {
      vp, bend: s.bend, st: s.st, time: s.time, px: H * 1.9 * (0.55 / (s.cam.fov || 0.55)),
      focusD: s.cam.dist, dof: s.dof ?? 0.55, kind: s.kind ?? -1, kindK: s.kindK ?? 0,
    };

    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.f); gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(P.snow.p); gl.uniformMatrix4fv(P.snow.u.u_vp, false, vp); gl.uniform1f(P.snow.u.u_time, s.time); gl.uniform1f(P.snow.u.u_px, st.px);
    gl.bindVertexArray(snowVao); gl.drawArrays(gl.POINTS, 0, SNOW);
    if (quality !== 'low') { bindData(P.haze, st); gl.uniform1f(P.haze.u.u_haze, s.haze ?? 0.02); gl.bindVertexArray(hazeVao); gl.drawArrays(gl.POINTS, 0, drawn.length); }
    const anat = s.anatomy ?? 0;
    if ((shell || yolk) && anat > 0.01) {
      bindData(P.shell, st);
      const cp = Math.cos(s.cam.pitch), ty = s.cam.ty ?? -0.16;
      gl.uniform3f(P.shell.u.u_eye, Math.sin(s.cam.yaw) * cp * s.cam.dist, ty + Math.sin(s.cam.pitch) * s.cam.dist, Math.cos(s.cam.yaw) * cp * s.cam.dist);
      if (shell) { gl.uniform3f(P.shell.u.u_tint, 0.35, 0.62, 0.8); gl.uniform1f(P.shell.u.u_shell, 0.14 * anat); gl.bindVertexArray(shell.vao); gl.drawElements(gl.TRIANGLES, shell.count, shell.type, 0); }
      if (yolk) { gl.uniform3f(P.shell.u.u_tint, 0.75, 0.62, 0.42); gl.uniform1f(P.shell.u.u_shell, 0.035 * anat); gl.bindVertexArray(yolk.vao); gl.drawElements(gl.TRIANGLES, yolk.count, yolk.type, 0); }
    }
    if (morph && anat > 0.01) {
      bindData(P.morph, st); gl.uniform1f(P.morph.u.u_morph, anat); gl.uniform1f(P.morph.u.u_hasFocus, focusIdx >= 0 ? 1 : 0);
      gl.bindVertexArray(morph.vao); gl.drawElements(gl.LINES, morph.count, gl.UNSIGNED_INT, 0);
    }
    bindData(P.edge, st); gl.uniform1f(P.edge.u.u_edge, 0.55 * (1 - 0.45 * anat)); gl.uniform1f(P.edge.u.u_web, (s.web ?? 0.014) * (1 - 0.7 * anat)); gl.uniform1f(P.edge.u.u_focusIdx, focusIdx);
    gl.bindVertexArray(edgeVao); gl.drawArrays(gl.LINES, 0, E * 2);
    bindData(P.spark, st); gl.bindVertexArray(sparkVao); gl.drawArrays(gl.POINTS, 0, E);
    bindData(P.cell, st); gl.uniform1f(P.cell.u.u_hover, s.hover ?? -1); gl.uniform1f(P.cell.u.u_hasFocus, focusIdx >= 0 ? 1 : 0);
    gl.bindVertexArray(cellVao); gl.drawArrays(gl.POINTS, 0, drawn.length);
    gl.disable(gl.BLEND);

    // bloom: downsample the scene through the mip chain, then add it back up
    pass(P.down, scene, mips[0], () => gl.uniform1f(P.down.u.u_thresh, 0.04));
    for (let k = 1; k < mips.length; k++) pass(P.down, mips[k - 1], mips[k], () => gl.uniform1f(P.down.u.u_thresh, 0));
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (let k = mips.length - 1; k > 0; k--) pass(P.up, mips[k], mips[k - 1]);
    gl.disable(gl.BLEND);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
    gl.useProgram(P.comp.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, scene.t); gl.uniform1i(P.comp.u.u_scene, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mips[0].t); gl.uniform1i(P.comp.u.u_bloom, 1);
    gl.uniform1f(P.comp.u.u_bloomK, s.bloom ?? 1.25); gl.uniform1f(P.comp.u.u_shock, s.shock || 0);
    gl.uniform1f(P.comp.u.u_time, s.time); gl.uniform1f(P.comp.u.u_exposure, s.exposure ?? 1.15); gl.uniform2f(P.comp.u.u_res, W, H);
    gl.uniform2f(P.comp.u.u_center, 0.5 + (s.cam.ox || 0) * 0.5, 0.5 - (s.cam.oy || 0) * 0.5);
    gl.bindVertexArray(quadVao); gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  return { kind: 'webgl', canvas, resize, frame, setMorph, get hasMorph() { return !!morph; }, get vp() { return vp; }, get size() { return [W, H]; }, hdr, partners };
}
