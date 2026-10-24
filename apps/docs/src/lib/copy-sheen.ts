/**
 * Copy feedback for code blocks: the block pops slightly and a soft, glossy
 * light sweeps diagonally across it, catching its edges on the way.
 *
 * Timing and shape are tuned to match the Rex docs (superlogical.com/rex/docs).
 * The pop scales the block's wrapper; the sweep is drawn by a WebGL canvas laid
 * over the block. Light fills cannot get brighter, so on them the sweep shows by
 * contrast instead: its flanks are multiplied towards an accent tint while the
 * core stays clean, which also keeps dark text dark.
 */

const TUNING = {
    maxPop: 0.016,
    maxShift: 0.1,
    slant: 0.358,
    coreWidth: 1.595,
    bloomWidth: 5.573,
    rimLobeWidth: 10.133,
    spanScale: 0.054,
    coreStrength: 0.3,
    bloomStrength: 0.175,
    rimStrength: 1.016,
    rimGlowWidth: 0.133,
    rimHairline: 0.625,
    rimTopBias: 0.331,
    largeDimming: 0.35,
    largeSlowdown: 1.6,
    lightFillBoost: 1.883,
    flankDeepening: 0.513,
} as const;

/** Base duration of the whole effect, in milliseconds. */
const DURATION_MS = 391;
/** Share of the duration spent growing; the rest is spent settling back. */
const RISE = 0.42;
/** Block sizes, in line heights, between which large-block adjustments ramp in. */
const LARGE_FROM = 10;
const LARGE_TO = 70;

const f = (n: number) => n.toFixed(4);

const VERTEX_SHADER = `
attribute vec2 corner;
void main() {
    gl_Position = vec4(corner, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
precision highp float;

uniform vec2 size;
uniform float line;
uniform float radius;
uniform float sheen;
uniform float light_fill;
uniform vec3 tint;
uniform float boost;

void main() {
    vec2 pixel = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y);

    // Signed distance to the rounded block edge, negative inside.
    vec2 from_center = pixel - size * 0.5;
    vec2 q = abs(from_center) - (size * 0.5 - radius);
    float outside = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
    float coverage = clamp(0.5 - outside, 0.0, 1.0);

    // A light leaning like "/" travels from fully before the block to fully past it.
    float diagonal = pixel.x + pixel.y * ${f(TUNING.slant)};
    float span = size.x + size.y * ${f(TUNING.slant)};
    float unit = max(line, span * ${f(TUNING.spanScale)});
    float core_w = max(unit * ${f(TUNING.coreWidth)}, 1.0);
    float bloom_w = max(unit * ${f(TUNING.bloomWidth)}, 1.0);
    float rim_w = max(unit * ${f(TUNING.rimLobeWidth)}, 1.0);
    float reach = max(rim_w, bloom_w) * 1.5;
    float d = diagonal - mix(-reach, span + reach, sheen);

    // Fade in and out over the sweep, and calm the body of large blocks.
    float envelope = smoothstep(0.0, 0.2, sheen) * (1.0 - smoothstep(0.8, 1.0, sheen));
    float calm = mix(1.0, ${f(TUNING.largeDimming)},
        smoothstep(${f(LARGE_FROM)}, ${f(LARGE_TO)}, (span + size.y * 2.0) / line));

    float core = exp(-pow(d / core_w, 2.0)) * envelope * calm;
    float bloom = exp(-pow(d / bloom_w, 2.0)) * envelope * calm;
    float rim = exp(-pow(d / rim_w, 2.0)) * envelope;

    // Edges facing up catch the most light: a crisp hairline plus a soft falloff.
    float depth = max(-outside, 0.0);
    vec2 normal = q.x > 0.0 && q.y > 0.0
        ? normalize(q) * sign(from_center)
        : (q.x > q.y ? vec2(sign(from_center.x), 0.0) : vec2(0.0, sign(from_center.y)));
    float facing = (1.0 - ${f(TUNING.rimTopBias)}) - ${f(TUNING.rimTopBias)} * normal.y;
    float hairline = max(line * 0.035, 1.0);
    float glow = max(line * ${f(TUNING.rimGlowWidth)}, 1.0);
    float edge = facing * mix(exp(-depth / glow), exp(-depth * depth / (hairline * hairline)), ${f(TUNING.rimHairline)});
    float edge_light = edge * ${f(TUNING.rimStrength)} * (rim * 0.55 + bloom * 0.45);

    if (light_fill > 0.5) {
        // Multiplied into the block: the flanks deepen towards the tint.
        float flank = max(bloom - core, 0.0);
        float deepen = clamp((flank * ${f(TUNING.flankDeepening)} * light_fill + edge_light) * boost, 0.0, 1.0);
        gl_FragColor = vec4(mix(vec3(1.0), tint, deepen), 1.0) * coverage;
    } else {
        // Premultiplied white over a dark fill brightens without clipping.
        float amount = core * ${f(TUNING.coreStrength)} + bloom * ${f(TUNING.bloomStrength)} + edge_light;
        amount = clamp(amount * (1.0 + light_fill * ${f(TUNING.lightFillBoost)}) * boost, 0.0, 1.0);
        gl_FragColor = vec4(amount * coverage);
    }
}`;

interface SheenRenderer {
    canvas: HTMLCanvasElement;
    gl: WebGLRenderingContext;
    uniforms: Record<'size' | 'line' | 'radius' | 'sheen' | 'lightFill' | 'tint' | 'boost', WebGLUniformLocation | null>;
}

let renderer: SheenRenderer | null | undefined;
let stopCurrent: (() => void) | undefined;

function createRenderer(): SheenRenderer | null {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { antialias: false });
    if (!gl) return null;

    const program = gl.createProgram();
    if (!program) return null;
    for (const [type, source] of [
        [gl.VERTEX_SHADER, VERTEX_SHADER],
        [gl.FRAGMENT_SHADER, FRAGMENT_SHADER],
    ] as const) {
        const shader = gl.createShader(type);
        if (!shader) return null;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    gl.useProgram(program);

    // One triangle that covers the whole viewport.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(program, 'corner');
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;pointer-events:none';

    return {
        canvas,
        gl,
        uniforms: {
            size: gl.getUniformLocation(program, 'size'),
            line: gl.getUniformLocation(program, 'line'),
            radius: gl.getUniformLocation(program, 'radius'),
            sheen: gl.getUniformLocation(program, 'sheen'),
            lightFill: gl.getUniformLocation(program, 'light_fill'),
            tint: gl.getUniformLocation(program, 'tint'),
            boost: gl.getUniformLocation(program, 'boost'),
        },
    };
}

function getRenderer(): SheenRenderer | null {
    if (renderer === undefined || renderer?.gl.isContextLost()) renderer = createRenderer();
    return renderer;
}

let colorProbe: CanvasRenderingContext2D | null | undefined;

/** Resolve any CSS colour to linear-ish RGB in 0..1. */
function toRgb(color: string): [number, number, number] {
    colorProbe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!colorProbe || !color) return [1, 1, 1];
    colorProbe.clearRect(0, 0, 1, 1);
    colorProbe.fillStyle = '#fff';
    colorProbe.fillStyle = color;
    colorProbe.fillRect(0, 0, 1, 1);
    const [r = 255, g = 255, b = 255] = colorProbe.getImageData(0, 0, 1, 1).data;
    return [r / 255, g / 255, b / 255];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
    return t * t * (3 - 2 * t);
}

const cosineEase = (t: number) => (1 - Math.cos(t * Math.PI)) / 2;

/** Pop and sheen values at progress `p` in [0, 1), or null once finished. */
function frameAt(p: number): { pop: number; sheen: number } | null {
    if (!(p >= 0 && p < 1)) return null;
    const pop = cosineEase(p < RISE ? p / RISE : (1 - p) / (1 - RISE));
    const sweep = p / (2 * Math.min(RISE, 1 - RISE));
    return { pop, sheen: sweep <= 1 ? cosineEase(sweep) : -1 };
}

/** Play the copy feedback on a code block's `<pre>`. */
export function playCopySheen(pre: HTMLElement): void {
    const wrapper = pre.parentElement;
    if (!wrapper || matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    stopCurrent?.();

    const style = getComputedStyle(pre);
    const width = pre.offsetWidth;
    const height = pre.offsetHeight;
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;

    // Small blocks pop by up to 1.6%; larger ones move by at most a tenth of a line.
    const amplitude = Math.min(TUNING.maxPop, (line * TUNING.maxShift) / Math.max(Math.max(width, height) / 2, 1));
    const size = (width + height * TUNING.slant + height * 2) / line;
    const duration = DURATION_MS * (1 + (TUNING.largeSlowdown - 1) * smoothstep(LARGE_FROM, LARGE_TO, size));

    const r = getRenderer();
    if (r) {
        const { canvas, gl, uniforms } = r;
        const dpr = devicePixelRatio;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.left = `${pre.offsetLeft}px`;
        canvas.style.top = `${pre.offsetTop}px`;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        const [fr, fg, fb] = toRgb(style.getPropertyValue('--tk-code-fill').trim() || style.backgroundColor);
        const lightFill = smoothstep(0.55, 0.85, 0.2126 * fr + 0.7152 * fg + 0.0722 * fb);
        canvas.style.mixBlendMode = lightFill > 0.5 ? 'multiply' : 'normal';

        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(uniforms.size, canvas.width, canvas.height);
        gl.uniform1f(uniforms.line, line * dpr);
        gl.uniform1f(
            uniforms.radius,
            Math.min(parseFloat(style.borderTopLeftRadius) || 0, width / 2, height / 2) * dpr,
        );
        gl.uniform1f(uniforms.lightFill, lightFill);
        gl.uniform3fv(uniforms.tint, toRgb(style.getPropertyValue('--tk-code-accent').trim()));
        // Overall sheen strength; above 1 compensates for a dark block sitting on a light page.
        gl.uniform1f(uniforms.boost, parseFloat(style.getPropertyValue('--tk-code-sheen')) || 1);
        wrapper.append(canvas);
    }

    wrapper.style.transformOrigin = `${pre.offsetLeft + width / 2}px ${pre.offsetTop + height / 2}px`;
    wrapper.style.willChange = 'transform';

    let start: number | undefined;
    let frame = requestAnimationFrame(function tick(now) {
        start ??= now;
        const state = frameAt((now - start) / duration);
        if (!state) {
            stopCurrent?.();
            return;
        }
        wrapper.style.transform = `scale(${1 + amplitude * state.pop})`;
        if (r) {
            r.gl.uniform1f(r.uniforms.sheen, state.sheen);
            r.gl.clear(r.gl.COLOR_BUFFER_BIT);
            if (state.sheen >= 0) r.gl.drawArrays(r.gl.TRIANGLES, 0, 3);
        }
        frame = requestAnimationFrame(tick);
    });

    stopCurrent = () => {
        cancelAnimationFrame(frame);
        r?.canvas.remove();
        wrapper.style.transform = '';
        wrapper.style.transformOrigin = '';
        wrapper.style.willChange = '';
        stopCurrent = undefined;
    };
}
