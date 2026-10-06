// Небольшой WebGL2-движок: сцена из узлов, освещение «металл/пластик»,
// орбитальная камера, выбор объекта щелчком, плоскость разреза, прозрачность.
import { M, V, type Mat4, type Vec3 } from './math';
import type { Geometry } from './geometry';

export interface Material {
  color: Vec3;          // линейный-ish RGB 0..1
  metal?: number;       // 0..1
  rough?: number;       // 0..1
  emissive?: Vec3;      // добавочное свечение
  opacity?: number;     // 0..1
  unlit?: boolean;      // без освещения (индикаторы, искры)
  noClip?: boolean;     // не обрезать плоскостью разреза
}

export class Node3 {
  name = '';
  /** Подпись для человека (подсказка при наведении). */
  label = '';
  geom: Geometry | null = null;
  mat: Material = { color: [0.7, 0.7, 0.72] };
  local: Mat4 = M.identity();
  world: Mat4 = M.identity();
  children: Node3[] = [];
  parent: Node3 | null = null;
  visible = true;
  /** Можно ли выбрать щелчком. Если false — щелчок достаётся ближайшему выбираемому предку. */
  pickable = false;
  /** Произвольные данные приложения (идентификатор цепи, детали и т. п.). */
  data: Record<string, unknown> = {};
  /** Подсветка (наведение/выбор) 0..1. */
  highlight = 0;
  _id = 0;
  _gpu: { vao: WebGLVertexArrayObject; count: number; center: Vec3 } | null = null;

  constructor(name = '', geom: Geometry | null = null, mat?: Material) {
    this.name = name;
    this.geom = geom;
    if (mat) this.mat = mat;
  }
  add<T extends Node3>(child: T): T {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove(child: Node3) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parent = null;
  }
  traverse(fn: (n: Node3) => void) {
    fn(this);
    for (const c of this.children) c.traverse(fn);
  }
  find(name: string): Node3 | null {
    let r: Node3 | null = null;
    this.traverse((n) => { if (!r && n.name === name) r = n; });
    return r;
  }
  setPos(x: number, y: number, z: number) { this.local = M.translation(x, y, z); return this; }
}

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNor;
uniform mat4 uModel, uViewProj;
out vec3 vPos, vNor;
void main(){
  vec4 w = uModel * vec4(aPos,1.0);
  vPos = w.xyz;
  vNor = mat3(uModel) * aNor;
  gl_Position = uViewProj * w;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vPos, vNor;
uniform vec3 uColor, uEmissive, uCam, uPickColor;
uniform float uMetal, uRough, uOpacity, uHighlight, uUnlit, uPick, uClipOn;
uniform vec4 uClip;
out vec4 o;
vec3 env(vec3 d){ // простая «студия»: тёмный пол, светлый софтбокс сверху, полоса света на горизонте
  float t = d.y*0.5+0.5;
  vec3 c = mix(vec3(0.05,0.06,0.08), vec3(0.34,0.38,0.44), smoothstep(0.0,1.0,t));
  c += vec3(0.95,0.97,1.0) * pow(max(d.y,0.0), 6.0) * 0.9;
  c += vec3(1.0,0.86,0.68) * pow(max(dot(d, normalize(vec3(0.75,0.3,0.55))),0.0), 24.0) * 1.2;
  c += vec3(0.5,0.7,1.0) * pow(max(dot(d, normalize(vec3(-0.8,0.15,-0.5))),0.0), 10.0) * 0.5;
  c += vec3(0.25) * (1.0 - smoothstep(0.0,0.12,abs(d.y)));
  return c;
}
void main(){
  if (uClipOn > 0.5 && dot(vec4(vPos,1.0), uClip) > 0.0) discard;
  if (uPick > 0.5) { o = vec4(uPickColor,1.0); return; }
  if (uUnlit > 0.5) { o = vec4(uColor + uEmissive, uOpacity); return; }
  vec3 N = normalize(vNor), Vd = normalize(uCam - vPos);
  bool back = dot(N,Vd) < 0.0;
  if (back) N = -N;
  vec3 base = uColor;
  float metal = uMetal, rough = clamp(uRough,0.05,1.0);
  if (back && uClipOn > 0.5) { // изнанка в разрезе: ровная «штриховка среза» без бликов
    vec3 cut = mix(base, vec3(0.78,0.27,0.2), 0.6) * (0.62 + 0.3*abs(N.y) + 0.12*abs(N.x));
    o = vec4(pow(cut, vec3(1.0/2.2)), uOpacity); return;
  }
  vec3 L1 = normalize(vec3(0.55,0.8,0.45)), L2 = normalize(vec3(-0.7,0.35,-0.4)), L3 = normalize(vec3(0.1,-0.6,0.8));
  float d1 = max(dot(N,L1),0.0), d2 = max(dot(N,L2),0.0), d3 = max(dot(N,L3),0.0);
  vec3 hemi = mix(vec3(0.10,0.11,0.13), vec3(0.42,0.46,0.52), N.y*0.5+0.5);
  vec3 diff = base * (hemi + vec3(1.0,0.96,0.9)*d1*0.95 + vec3(0.45,0.55,0.75)*d2*0.45 + vec3(0.3)*d3*0.2) * (1.0 - metal*0.85);
  float sh = mix(220.0, 6.0, rough);
  vec3 H1 = normalize(L1+Vd), H2 = normalize(L2+Vd);
  float s1 = pow(max(dot(N,H1),0.0), sh) * (1.0-rough*0.8), s2 = pow(max(dot(N,H2),0.0), sh) * (1.0-rough*0.8) * 0.5;
  vec3 specCol = mix(vec3(0.045), base, metal);
  float fres = pow(1.0 - max(dot(N,Vd),0.0), 5.0);
  vec3 R = reflect(-Vd, N);
  vec3 refl = env(normalize(mix(R, N, rough*rough))) * mix(specCol, vec3(1.0), fres) * mix(1.0, 0.35, rough);
  vec3 col = diff + specCol*(s1+s2)*2.2 + refl * mix(0.35, 1.0, metal) + uEmissive;
  col = mix(col, vec3(0.25,0.85,1.0), uHighlight*0.45) + vec3(0.1,0.5,0.7)*uHighlight*fres;
  col = col / (col + vec3(0.85)) * 1.45;       // мягкая тональная компрессия
  col = pow(col, vec3(1.0/2.2));
  o = vec4(col, uOpacity);
}`;

export interface PickResult { node: Node3; id: number }
export interface Camera { target: Vec3; yaw: number; pitch: number; dist: number; fov: number; minDist: number; maxDist: number }

export class Viewer {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  root = new Node3('root');
  /** Параметры орбитальной камеры. */
  cam: Camera = { target: [0, 0, 0], yaw: 0.7, pitch: 0.35, dist: 10, fov: 0.6, minDist: 1, maxDist: 100 };
  /** Плоскость разреза (ax+by+cz+d > 0 отсекается) или null. */
  clip: [number, number, number, number] | null = null;
  background: [Vec3, Vec3] = [[0.035, 0.05, 0.075], [0.09, 0.115, 0.15]];
  onFrame: ((dt: number, t: number) => void) | null = null;
  onPick: ((hit: Node3 | null, ev: PointerEvent) => void) | null = null;
  onHover: ((hit: Node3 | null, ev: PointerEvent) => void) | null = null;
  viewProj: Mat4 = M.identity();

  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private bgProg: WebGLProgram;
  private raf = 0;
  private last = 0;
  private disposed = false;
  private ro: ResizeObserver;
  private nextId = 1;
  private byId = new Map<number, Node3>();
  private pickFbo: WebGLFramebuffer | null = null;
  private pickTex: WebGLTexture | null = null;
  private pickDepth: WebGLRenderbuffer | null = null;
  private pickW = 0;
  private pickH = 0;
  private camAnim: { from: Camera; to: Partial<Camera>; t: number; dur: number } | null = null;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;outline:none';
    container.appendChild(this.canvas);
    const gl = this.canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 недоступен в этом браузере');
    this.gl = gl;
    this.prog = this.link(VS, FS);
    for (const n of ['uModel', 'uViewProj', 'uColor', 'uEmissive', 'uCam', 'uPickColor', 'uMetal', 'uRough', 'uOpacity', 'uHighlight', 'uUnlit', 'uPick', 'uClipOn', 'uClip'])
      this.u[n] = gl.getUniformLocation(this.prog, n);
    this.bgProg = this.link(
      `#version 300 es
       out vec2 v; void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); v = p; gl_Position = vec4(p*2.0-1.0, 0.999, 1.0); }`,
      `#version 300 es
       precision highp float; in vec2 v; uniform vec3 a, b; out vec4 o;
       void main(){ float r = length(v-vec2(0.5,0.55)); o = vec4(mix(b, a, smoothstep(0.0,0.85,r)), 1.0); }`);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.bindControls();
    this.last = performance.now();
    const loop = (now: number) => {
      if (this.disposed) return;
      const dt = Math.min(0.25, (now - this.last) / 1000);
      this.last = now;
      this.tickCam(dt);
      this.onFrame?.(dt, now / 1000);
      this.render();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.canvas.remove();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /** Плавно перевести камеру в новое положение. */
  flyTo(to: Partial<Camera>, dur = 0.6) {
    this.camAnim = { from: { ...this.cam, target: [...this.cam.target] as Vec3 }, to, t: 0, dur };
  }

  /** Экранные координаты (CSS-пиксели относительно canvas) мировой точки. */
  project(p: Vec3): { x: number; y: number; visible: boolean } {
    const m = this.viewProj;
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    const x = (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w;
    const y = (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w;
    return { x: (x * 0.5 + 0.5) * this.canvas.clientWidth, y: (1 - (y * 0.5 + 0.5)) * this.canvas.clientHeight, visible: w > 0 };
  }

  eye(): Vec3 {
    const c = this.cam, cp = Math.cos(c.pitch);
    return [c.target[0] + c.dist * cp * Math.sin(c.yaw), c.target[1] + c.dist * Math.sin(c.pitch), c.target[2] + c.dist * cp * Math.cos(c.yaw)];
  }

  /** Вернуть выбираемый узел под точкой (CSS-координаты относительно canvas). */
  pickAt(x: number, y: number): Node3 | null {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    if (!w || !h) return null;
    if (!this.pickFbo || this.pickW !== w || this.pickH !== h) {
      if (this.pickFbo) { gl.deleteFramebuffer(this.pickFbo); gl.deleteTexture(this.pickTex); gl.deleteRenderbuffer(this.pickDepth); }
      this.pickFbo = gl.createFramebuffer();
      this.pickTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.pickTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      this.pickDepth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepth);
      this.pickW = w; this.pickH = h;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.drawScene(true);
    const px = new Uint8Array(4), dpr = w / this.canvas.clientWidth;
    gl.readPixels(Math.round(x * dpr), h - 1 - Math.round(y * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const id = px[0] | (px[1] << 8) | (px[2] << 16);
    let n = this.byId.get(id) ?? null;
    while (n && !n.pickable) n = n.parent;
    return n;
  }

  /** Сбросить загруженную в видеокарту геометрию узла (после замены node.geom). */
  invalidate(node: Node3) {
    if (node._gpu) { this.gl.deleteVertexArray(node._gpu.vao); node._gpu = null; }
  }

  private link(vs: string, fs: string): WebGLProgram {
    const gl = this.gl, p = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Шейдер: ' + gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Программа: ' + gl.getProgramInfoLog(p));
    return p;
  }

  private resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr)), h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  private tickCam(dt: number) {
    const a = this.camAnim;
    if (!a) return;
    a.t = Math.min(1, a.t + dt / a.dur);
    const e = a.t < 0.5 ? 2 * a.t * a.t : 1 - Math.pow(-2 * a.t + 2, 2) / 2;
    const lerp = (x: number, y: number) => x + (y - x) * e;
    if (a.to.yaw !== undefined) {
      let d = a.to.yaw - a.from.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.cam.yaw = a.from.yaw + d * e;
    }
    if (a.to.pitch !== undefined) this.cam.pitch = lerp(a.from.pitch, a.to.pitch);
    if (a.to.dist !== undefined) this.cam.dist = lerp(a.from.dist, a.to.dist);
    if (a.to.target) this.cam.target = V.lerp(a.from.target, a.to.target, e);
    if (a.t >= 1) this.camAnim = null;
  }

  private bindControls() {
    const c = this.canvas;
    let mode: 'none' | 'rot' | 'pan' = 'none', lx = 0, ly = 0, moved = 0, downX = 0, downY = 0;
    const pts = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      mode = e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : 'rot';
      lx = downX = e.clientX; ly = downY = e.clientY; moved = 0;
      this.camAnim = null;
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) this.cam.dist = Math.min(this.cam.maxDist, Math.max(this.cam.minDist, this.cam.dist * (pinch / d)));
        pinch = d;
        return;
      }
      if (mode === 'none') {
        if (this.onHover) this.onHover(this.pickAt(e.clientX - r.left, e.clientY - r.top), e);
        return;
      }
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      moved = Math.max(moved, Math.hypot(e.clientX - downX, e.clientY - downY));
      if (mode === 'rot') {
        this.cam.yaw -= dx * 0.008;
        this.cam.pitch = Math.max(-1.45, Math.min(1.45, this.cam.pitch + dy * 0.008));
      } else {
        const k = (this.cam.dist * Math.tan(this.cam.fov / 2) * 2) / c.clientHeight;
        const eye = this.eye(), f = V.norm(V.sub(this.cam.target, eye));
        const right = V.norm(V.cross(f, [0, 1, 0])), up = V.cross(right, f);
        this.cam.target = V.add(this.cam.target, V.add(V.mul(right, -dx * k), V.mul(up, dy * k)));
      }
    });
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      pinch = 0;
      if (mode !== 'none' && moved < 4 && this.onPick) {
        const r = c.getBoundingClientRect();
        this.onPick(this.pickAt(e.clientX - r.left, e.clientY - r.top), e);
      }
      mode = 'none';
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camAnim = null;
      this.cam.dist = Math.min(this.cam.maxDist, Math.max(this.cam.minDist, this.cam.dist * Math.exp(e.deltaY * 0.0012)));
    }, { passive: false });
  }

  private upload(n: Node3) {
    const gl = this.gl, g = n.geom!;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const pb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pb);
    gl.bufferData(gl.ARRAY_BUFFER, g.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const nb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nb);
    gl.bufferData(gl.ARRAY_BUFFER, g.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const c: Vec3 = [0, 0, 0], np = g.positions.length / 3 || 1;
    for (let i = 0; i < g.positions.length; i += 3) { c[0] += g.positions[i]; c[1] += g.positions[i + 1]; c[2] += g.positions[i + 2]; }
    n._gpu = { vao, count: g.indices.length, center: [c[0] / np, c[1] / np, c[2] / np] };
  }

  private updateWorld(n: Node3, parent: Mat4 | null, visible: boolean, out: Node3[]) {
    n.world = parent ? M.mul(parent, n.local) : n.local;
    const vis = visible && n.visible;
    if (vis && n.geom) out.push(n);
    if (!n._id) { n._id = this.nextId++; this.byId.set(n._id, n); }
    for (const c of n.children) this.updateWorld(c, n.world, vis, out);
  }

  private drawScene(pick: boolean) {
    const gl = this.gl, u = this.u;
    const aspect = this.canvas.width / this.canvas.height, eye = this.eye();
    const near = Math.max(0.01, this.cam.dist * 0.02), far = this.cam.dist * 20 + 50;
    this.viewProj = M.mul(M.perspective(this.cam.fov, aspect, near, far), M.lookAt(eye, this.cam.target, [0, 1, 0]));
    const list: Node3[] = [];
    this.updateWorld(this.root, null, true, list);
    gl.useProgram(this.prog);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.uniformMatrix4fv(u.uViewProj, false, this.viewProj);
    gl.uniform3fv(u.uCam, eye);
    gl.uniform1f(u.uPick, pick ? 1 : 0);
    if (this.clip) gl.uniform4fv(u.uClip, this.clip);
    const draw = (n: Node3) => {
      if (!n._gpu) this.upload(n);
      const m = n.mat;
      gl.uniformMatrix4fv(u.uModel, false, n.world);
      gl.uniform1f(u.uClipOn, this.clip && !m.noClip ? 1 : 0);
      if (pick) gl.uniform3f(u.uPickColor, (n._id & 255) / 255, ((n._id >> 8) & 255) / 255, ((n._id >> 16) & 255) / 255);
      else {
        gl.uniform3fv(u.uColor, m.color);
        gl.uniform3fv(u.uEmissive, m.emissive ?? [0, 0, 0]);
        gl.uniform1f(u.uMetal, m.metal ?? 0);
        gl.uniform1f(u.uRough, m.rough ?? 0.6);
        gl.uniform1f(u.uOpacity, m.opacity ?? 1);
        gl.uniform1f(u.uUnlit, m.unlit ? 1 : 0);
        let h = 0;
        for (let p: Node3 | null = n; p; p = p.parent) h = Math.max(h, p.highlight);
        gl.uniform1f(u.uHighlight, h);
      }
      gl.bindVertexArray(n._gpu!.vao);
      gl.drawElements(gl.TRIANGLES, n._gpu!.count, gl.UNSIGNED_INT, 0);
    };
    const opaque = list.filter((n) => (n.mat.opacity ?? 1) >= 0.999), transp = list.filter((n) => (n.mat.opacity ?? 1) < 0.999);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    for (const n of opaque) draw(n);
    if (pick) {
      // почти невидимые оболочки не должны перехватывать щелчок
      for (const n of transp) if ((n.mat.opacity ?? 1) > 0.5) draw(n);
    } else if (transp.length) {
      const d = (n: Node3) => { if (!n._gpu) this.upload(n); const w = M.point(n.world, n._gpu!.center); return (w[0] - eye[0]) ** 2 + (w[1] - eye[1]) ** 2 + (w[2] - eye[2]) ** 2; };
      transp.sort((a, b) => d(b) - d(a));
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const n of transp) draw(n);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
  }

  render() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.bgProg);
    gl.disable(gl.DEPTH_TEST);
    gl.uniform3fv(gl.getUniformLocation(this.bgProg, 'a'), this.background[0]);
    gl.uniform3fv(gl.getUniformLocation(this.bgProg, 'b'), this.background[1]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.drawScene(false);
  }
}

/** Готовые материалы. */
export const MAT = {
  castAlu: (): Material => ({ color: [0.62, 0.64, 0.66], metal: 0.85, rough: 0.55 }),
  machinedAlu: (): Material => ({ color: [0.78, 0.8, 0.82], metal: 1, rough: 0.25 }),
  steel: (): Material => ({ color: [0.55, 0.57, 0.6], metal: 1, rough: 0.3 }),
  darkSteel: (): Material => ({ color: [0.2, 0.21, 0.23], metal: 0.9, rough: 0.45 }),
  brass: (): Material => ({ color: [0.83, 0.62, 0.25], metal: 1, rough: 0.3 }),
  copper: (): Material => ({ color: [0.85, 0.45, 0.25], metal: 1, rough: 0.35 }),
  rubber: (): Material => ({ color: [0.05, 0.05, 0.055], metal: 0, rough: 0.9 }),
  plastic: (c: Vec3): Material => ({ color: c, metal: 0, rough: 0.45 }),
  ceramic: (): Material => ({ color: [0.92, 0.91, 0.87], metal: 0, rough: 0.25 }),
  pcb: (): Material => ({ color: [0.04, 0.22, 0.42], metal: 0, rough: 0.5 }),
  gold: (): Material => ({ color: [0.95, 0.75, 0.3], metal: 1, rough: 0.2 }),
  glow: (c: Vec3): Material => ({ color: c, emissive: c, unlit: true, noClip: true }),
};
