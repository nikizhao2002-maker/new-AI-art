/**
 * 钓一盏鱼灯 - 粒子点云交互系统
 * 核心架构：纹理驱动粒子网格 + 手势控制 + 形态变换 + 鱼群模式
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WaterRipple } from './water-ripple.js';
import { FISH_TYPES, loadAllFishPointClouds, loadGLBMesh } from './glb-pointcloud.js';
import { applyStippleMaterial } from './mesh-stipple.js';
import { applySwimDeformation, FishDartController, FishSchool } from './fish-swim.js';
import { BubbleSystem, SplashSystem, CausticsEffect } from './water-effects.js';
import { startHandInput, pauseHandInput, resumeHandInput, handData as sharedHandData } from './src/hand-input.js';
import { ParticleScene } from './src/particle-scene.js';
import { CRAFT_INDEX_TO_PARTICLE, HIGH_DETAIL_LANTERN_MODELS } from './src/fish-manifest.js';

// ═══════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════
const CONFIG = {
    particleGrid: 256,        // 256×256 = 65536 粒子（备用morph）
    texSize: 256,             // 数据纹理尺寸（须与 particleGrid 一致）
    pointSize: 3.0,
    bgColor: 0x080810,
    cameraZ: 160,
    morphDuration: 4.0,       // 形态切换秒数（TD风格需要足够时间展示粒子飞散）
    boidsCount: 600,          // 鱼群数量
    finalModelUrl: 'assets/models/浮金鱼影tripo.glb',
};

const DEFAULTS = {
    pointSize: 5.0,
    relief: 0.0,
    fluidStrength: 0.0,
    breathAmp: 0.02,
    threshold: 0.12,
    tintColor: '#ffffff',
    tintStrength: 0.0,
    waterTheme: 'blue',
    ritualTimeouts: [15, 15, 18, 18, 15],
};
const SFX_GAIN = 0.18;

/**
 * 制灯阶段嵌入 outputs-video。
 * 单服务器收敛：始终走同源 ./outputs-video/index.html（serve.py 从根目录提供），
 * 不再依赖独立的 4174 端口服务器（消除 B2/B4：跨端口白屏、start.ps1 写死路径）。
 * 仍支持 ?craftVideoUrl= 显式覆盖。
 */
function resolveCraftVideoUrl() {
    const params = new URLSearchParams(location.search);
    const override = params.get('craftVideoUrl');
    if (override) return override;
    // 若直接在 outputs-video 目录下打开（port 4174 旧布局），用本目录 index.html
    if (location.port === '4174') {
        return new URL('./index.html', location.href).href;
    }
    return new URL('./outputs-video/index.html?v=20260609-craft10-ok-release', location.href).href;
}

let craftVideoOpen = false;
let craftVideoUrl = null;
let pendingCraftVideoOpen = false;
let craftAwaitingClapReturn = false;
let lanternRevealActive = false;
let lanternRevealScatterTex = null;
let lanternSummonStage = 'idle'; // idle | waiting | particles | outlineHold | model
let lanternOutlineHoldTimer = null;
let lanternRevealOriginalPointSize = null;
let lanternModelFadeProgress = 1;
let lanternSummonSweep = { lastX: null, travel: 0, stableFrames: 0, lastAt: 0 };
let lanternReadyTimer = null;
let lanternDanceHintTimer = null;
let lanternDanceGroup = null;
let lanternDanceInstances = [];
let lanternDanceStartedAt = 0;
let lanternDanceReleaseProgress = 0;
let lanternDanceReleased = false;
let lanternDanceGesture = { sawFist: false, openFrames: 0 };
let lanternMergeReturnScheduled = false; // 汇群完成后自动回到水面（无人值守循环）
let lanternAutoReleaseTimer = null;      // 长时间未放飞则自动放飞（无人值守兜底）
let lanternParticleCompleteTimer = null;
const highDetailLanternCache = new Map();
const clapReturnGesture = { lastX: null, travel: 0, stable: 0 };
const okConfirmGesture = { frames: 0, cooldown: 0 };

// 形态阶段（鱼影 → 鱼灯，中间过程暂时忽略）
const STAGES = [
    { name: '鱼影', key: 'fish' },
    { name: '鱼灯', key: 'lantern' },
];

// ═══════════════════════════════════════════════════════
// Shader 代码
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// 2D 图像粒子网格 Shader（参考 CULTURAL HERITAGE 方案）
// GLB → 渲染为2D图像 → 图像驱动粒子网格
// ═══════════════════════════════════════════════════════
const vertexShader = /* glsl */`
    uniform float uTime;
    uniform float uSize;
    uniform float uMorph;         // 0~1 变形进度
    uniform float uBreathAmp;
    uniform float uFluidStrength; // 流动扰动
    uniform float uScatter;       // 手势散开力度 0~1
    uniform vec3 uHandWorld;
    uniform float uWind;          // 吹气风力 0~1
    uniform sampler2D uPosA;      // 形态A 位置纹理 (RGBA Float)
    uniform sampler2D uPosB;      // 形态B 位置纹理
    uniform sampler2D uColA;      // 形态A 颜色纹理
    uniform sampler2D uColB;      // 形态B 颜色纹理
    uniform vec3 uTintColor;
    uniform float uTintStrength;

    attribute vec2 aUv;           // 数据纹理采样坐标

    varying vec3 vColor;
    varying float vLuma;

    void main() {
        // 从数据纹理采样 3D 位置
        vec3 posA = texture2D(uPosA, aUv).xyz;
        vec3 posB = texture2D(uPosB, aUv).xyz;
        vec3 pos = mix(posA, posB, uMorph);

        // 从数据纹理采样颜色
        vec3 colA = texture2D(uColA, aUv).rgb;
        vec3 colB = texture2D(uColB, aUv).rgb;
        vColor = mix(colA, colB, uMorph);

        // 计算亮度
        vLuma = dot(vColor, vec3(0.299, 0.587, 0.114));

        // 染色叠加
        if (uTintStrength > 0.01) {
            vColor = mix(vColor, vColor * uTintColor, uTintStrength * 0.6);
        }

        // ═══ 游动动画 ═══
        // 用粒子在模型上的归一化 X 位置作为尾部因子
        float normX = (pos.x + 45.0) / 90.0; // 假设模型宽度约90
        float tailFactor = smoothstep(-0.2, 0.6, normX);
        
        // 身体 S 形传播波（从头到尾递增）
        float bodyWave = sin(normX * 8.0 - uTime * 4.0) * tailFactor * 3.5;
        pos.y += bodyWave;
        
        // 尾部额外大幅摆动
        float tailExtra = smoothstep(0.6, 1.0, normX);
        pos.y += sin(uTime * 5.0 - normX * 3.0) * tailExtra * 5.0;
        
        // 胸鳍区域微振（身体中部）
        float finArea = smoothstep(0.2, 0.4, normX) * smoothstep(0.6, 0.4, normX);
        float finWave = sin(uTime * 8.0) * finArea * 2.0;
        pos.z += finWave;
        
        // 整体上下浮动
        pos.y += sin(uTime * 1.0) * 2.0;
        // 轻微左右游动
        pos.x += sin(uTime * 0.7) * 1.2;

        // 呼吸动画（微弱缩放）
        float breath = 1.0 + sin(uTime * 2.0) * uBreathAmp;
        pos *= breath;

        // 流动扰动
        if (uFluidStrength > 0.01) {
            float noise = sin(pos.y * 0.08 + uTime * 1.5) * cos(pos.x * 0.08 + uTime);
            pos.x += noise * uFluidStrength * (1.0 - vLuma);
            pos.y += noise * uFluidStrength * 0.5;
        }

        // ═══ TD 风格形态转换特效 ═══
        // morphScatter: 0→1→0 (中间最大散开)
        float morphScatter = sin(uMorph * 3.14159);
        float morphScatter2 = morphScatter * morphScatter; // 更强的中间爆发
        float rnd = fract(sin(dot(aUv, vec2(12.9898, 78.233))) * 43758.5453);
        float rnd2 = fract(sin(dot(aUv * 2.3, vec2(53.1, 97.3))) * 2847.3);
        float rnd3 = fract(sin(dot(aUv * 7.1, vec2(21.7, 43.1))) * 6271.9);

        // 爆发飞散（粒子从原位置向外飞散，大幅度）
        vec3 flyDir = normalize(pos + vec3(rnd - 0.5, rnd2 - 0.5, rnd3 - 0.5) * 2.0);
        float flyDist = morphScatter2 * (25.0 + rnd * 55.0);
        pos += flyDir * flyDist;

        // 漩涡旋转（绕中心螺旋运动，TD标志性效果）
        float spiralAngle = uTime * 2.5 + rnd * 6.2832 + morphScatter * rnd2 * 8.0;
        float spiralRadius = morphScatter * (4.0 + rnd3 * 12.0);
        pos.x += cos(spiralAngle) * spiralRadius;
        pos.z += sin(spiralAngle) * spiralRadius;
        pos.y += sin(uTime * 1.8 + rnd * 6.2832) * morphScatter * 6.0;

        // curl noise 湍流（有机流动感）
        float noiseT = uTime * 1.2 + rnd * 8.0;
        pos.x += sin(pos.y * 0.06 + noiseT) * morphScatter * 8.0;
        pos.y += cos(pos.x * 0.06 + noiseT * 0.7) * morphScatter * 5.0;
        pos.z += sin(pos.z * 0.04 + noiseT * 0.5) * morphScatter * 4.0;

        // 手势散开
        if (uScatter > 0.01) {
            float d = length(pos);
            if (d > 0.1) {
                vec3 dir = normalize(pos);
                float rnd2 = fract(sin(dot(aUv * 3.7, vec2(53.1, 97.3))) * 2847.3);
                float push = uScatter * (35.0 + rnd2 * 25.0);
                pos += dir * push;
                pos.z += (rnd2 - 0.5) * uScatter * 30.0;
            }
        }

        // 吹气风力
        if (uWind > 0.01) {
            float windRnd = fract(sin(dot(aUv + uTime * 0.1, vec2(37.1, 81.7))) * 4375.5);
            pos.x += uWind * (20.0 + windRnd * 30.0);
            pos.y += uWind * (windRnd - 0.5) * 15.0;
            pos.z += uWind * (windRnd - 0.3) * 8.0;
        }

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        // 变形时粒子放大3倍（更醒目的TD粒子效果）
        float morphSizeMul = 1.0 + morphScatter * 2.5;
        gl_PointSize = uSize * morphSizeMul * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const fragmentShader = /* glsl */`
    uniform vec3 uTintColor;
    uniform float uTintStrength;
    uniform float uThreshold;
    uniform float uMorph;

    varying vec3 vColor;
    varying float vLuma;

    void main() {
        // 亮度过低（黑色/极暗）丢弃
        if (vLuma < 0.08) discard;
        // 亮度过高（接近白色/背景）降透明度
        float highLumaFade = 1.0 - smoothstep(uThreshold - 0.15, uThreshold, vLuma);

        // 圆形粒子遮罩
        vec2 coord = gl_PointCoord - vec2(0.5);
        float r2 = dot(coord, coord);
        if (r2 > 0.25) discard;

        // 边缘柔化（中心亮，边缘渐暗）
        float edgeFade = 1.0 - smoothstep(0.3, 0.5, sqrt(r2));

        vec3 rgb = vColor;

        // 色彩增强：提亮 + 饱和度提升
        rgb = pow(rgb, vec3(0.75)); // 反 gamma 提亮
        rgb *= 1.2; // 整体提亮

        // 金色高光增强
        vec3 gold = vec3(0.85, 0.65, 0.2);
        rgb = mix(rgb, gold, vLuma * 0.12);

        // 染色叠加
        if (uTintStrength > 0.01) {
            rgb = mix(rgb, rgb * uTintColor, uTintStrength * 0.6);
        }

        // TD 风格变形发光：转变中粒子发出温暖光芒（高亮度）
        float morphGlow = sin(uMorph * 3.14159);
        vec3 glowColor = mix(vec3(0.4, 0.7, 1.0), vec3(1.0, 0.8, 0.3), uMorph); // 蓝→金渐变
        rgb = mix(rgb, glowColor, morphGlow * 0.7); // 更强的颜色覆盖
        rgb += glowColor * morphGlow * 0.8; // 叠加发光
        // 变形期间大幅增加透明度（粒子更亮更实）
        float morphAlphaBoost = morphGlow * 0.6;

        // NormalBlending 高alpha，使粒子重叠形成实心表面
        float finalAlpha = edgeFade * 0.88 * highLumaFade + morphAlphaBoost;
        finalAlpha = clamp(finalAlpha, 0.0, 1.0);
        gl_FragColor = vec4(rgb, finalAlpha);
    }
`;

// ═══════════════════════════════════════════════════════
// 全局变量
// ═══════════════════════════════════════════════════════
let scene, camera, renderer, controls, particleSystem, uniforms;
let finalModel = null;
let finalModelMixer = null;
let isFinalModelVisible = false;
let boidsGroup;
let waterRipple;
let ambientBackgroundParticles;
let clock = new THREE.Clock();
let currentStage = 0;
let isMorphing = false;
let morphProgress = 0;
let isBoidsMode = false;
let textures = [];

// 变形暗化遮罩
const morphOverlay = document.createElement('div');
morphOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);pointer-events:none;opacity:0;transition:opacity 0.5s;z-index:5;';
document.body.appendChild(morphOverlay);

// GLB 点云数据
let fishPointClouds = [];     // [{fish:{posTex,colTex}, lantern:{posTex,colTex}}, ...]
let currentFishIndex = 0;     // 当前鱼种索引

// 可嵌入粒子场景（鱼灯领取阶段激活，离开即释放显存）
let particleScene = null;
let particleSceneActive = false;
let pcTextures = { posA: null, posB: null, colA: null, colB: null };
// GLB 渲染为 2D 纹理（CRAFTING 阶段粒子系统用）
let fishRenderedTextures = { fish: null, lantern: null };
// GLB 网格模型（FISHING 阶段直接显示）
let fishMeshGroup = null;     // 当前显示的鱼网格 THREE.Group
let fishStippleMat = null;    // 粒子化材质引用
let fishMeshSwimTime = 0;     // 游动动画时间
let fishSwimCtrl = null;      // 当前目标鱼的游泳控制器
let fishSwimCtrls = [];       // 五条鱼各自的游泳控制器
let fishDartCtrl = null;      // 窜动行为控制器 FishDartController
let bgFishDartCtrls = [];     // 钓鱼阶段背景鱼游动
let fishSchool = null;        // 放生阶段鱼群 FishSchool
let fishingLine = null;       // 钓鱼线+鱼钩 Three.js 对象
let lanternMeshGroup = null;  // 鱼灯 GLB 模型
let allFishMeshes = [];       // 五种鱼型模板（各 1 个，用于克隆与放生阶段）
let waterFishInstances = [];  // 水中鱼影实例（同型多条，分散游动）
let targetFishInstance = null;  // 本次被钓中的那条实例
let bubbleSystem = null;      // 气泡特效
let splashSystem = null;      // 水花特效
let causticsEffect = null;    // 焦散光影
let handData = { detected: false, palmX: 0, palmY: 0, pinchDist: 1.0, isPinching: false, pinchCooldown: 0, fingersUp: 0 };
let sfxContext = null;
let sfxMaster = null;
// 旧版水平切换手势状态（保留占位，主流程已改为仪式手势）
let swipeState = { lastPalmX: 0, swipeAccum: 0, swipeCooldown: 0 };
// 张手/握拳散聚状态
let scatterStrength = 0; // 0=聚拢, 1=最大散开
let openPalmHoldTime = 0; // 张手保持时间（需>0.5s才触发散开）

// ── 制灯/放生 仪式手势状态机 ──────────────────────────────
// 每个手势有独立的积累计数器 + 冷却，防止误触
const RITUAL_COOLDOWN = 90; // 手势触发后冷却帧数（约1.5s@60fps）
let ritualCooldown = 0;     // 全局冷却（触发任意手势后锁定）

// 手势1：双手向两侧推开 → 活鱼→骨架（stage 0→1）
// 检测：同时检测到两只手，且两手腕X距离持续扩大
let spreadGesture = { prevDist: 0, accumDelta: 0 };

// 手势2：单手从左到右缓慢抹过 → 骨架→糊纸（stage 1→2）
// 检测：手腕X从负到正持续移动，速度慢（仪式感）
let wipeGesture = { startX: null, traveling: false, accumX: 0 };

// 手势3：握拳→张开 → 糊纸→上色（stage 2→3）
// 检测：fingersUp从≤1升到≥4
let bloomGesture = { wasFist: false, holdFistTime: 0 };

// 合掌返回：双手从开到合（工艺页完成后）
// 手势4：双手靠近→向上托起 → 上色→鱼灯（stage 3→4）
// 检测：两手腕距离接近（<0.28）且双手整体上移
let liftGesture = { wasClose: false, closeTime: 0, startY: null, riseAccum: 0 };

// 放生手势：张开五指向前推→手腕持续上移 → 放生完成
// 检测：fingersUp=5 保持 + palmY持续减小（上移）
let releaseGesture = { openTime: 0, startY: null, riseAccum: 0 };

function getSfxContext() {
    if (!sfxContext) sfxContext = new (window.AudioContext || window.webkitAudioContext)();
    if (!sfxMaster) {
        sfxMaster = sfxContext.createGain();
        sfxMaster.gain.value = 0.35;
        sfxMaster.connect(sfxContext.destination);
    }
    if (sfxContext.state === 'suspended') sfxContext.resume();
    return sfxContext;
}

let sfxMuted = false; // HUD 静音开关
function playTone({
    freqs,
    type = 'sine',
    duration = 0.4,
    attack = 0.01,
    decay = 0.18,
    sustain = 0.2,
    release = 0.3,
    gain = 0.18,
    filterHz = null,
    noise = 0.0,
    detune = 0
} = {}) {
    if (sfxMuted) return;
    try {
        const ctx = getSfxContext();
        const now = ctx.currentTime;
        const env = ctx.createGain();
        const targetGain = SFX_GAIN;
        env.gain.setValueAtTime(0.0001, now);
        env.gain.linearRampToValueAtTime(targetGain, now + attack);
        env.gain.linearRampToValueAtTime(targetGain * sustain, now + attack + decay);
        env.gain.exponentialRampToValueAtTime(0.0001, now + duration + release);

        let out = env;
        if (filterHz) {
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = filterHz;
            env.connect(lp);
            out = lp;
        }
        out.connect(sfxMaster);

        const frequencyList = Array.isArray(freqs) ? freqs : [freqs];
        frequencyList.forEach((f) => {
            const osc = ctx.createOscillator();
            osc.type = type;
            osc.frequency.value = f;
            osc.detune.value = detune;
            osc.connect(env);
            osc.start(now);
            osc.stop(now + duration + release + 0.05);
        });

        if (noise > 0) {
            const buffer = ctx.createBuffer(1, ctx.sampleRate * (duration + release), ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * noise;
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            src.connect(env);
            src.start(now);
            src.stop(now + duration + release + 0.05);
        }
    } catch (e) {
        // Audio not available or blocked; ignore.
    }
}

function playPhaseSfx(phase) {
    switch (phase) {
        case PHASES.WATER:
            // Water droplet + soft shimmer
            playTone({ freqs: [660, 990], type: 'sine', duration: 0.18, attack: 0.005, decay: 0.06, sustain: 0.2, release: 0.12, gain: 0.14, filterHz: 1400, noise: 0.08 });
            break;
        case PHASES.FISHING:
            // Bamboo chime
            playTone({ freqs: [523.25, 783.99], type: 'triangle', duration: 0.35, attack: 0.01, decay: 0.12, sustain: 0.25, release: 0.25, gain: 0.2, filterHz: 1800 });
            break;
        case PHASES.CRAFTING:
            // Guqin pluck
            playTone({ freqs: 392.0, type: 'triangle', duration: 0.45, attack: 0.008, decay: 0.14, sustain: 0.2, release: 0.35, gain: 0.22, filterHz: 1200 });
            break;
        case PHASES.LANTERN_SWARM:
            // Bell-like release
            playTone({ freqs: [659.25, 1318.5], type: 'sine', duration: 0.6, attack: 0.01, decay: 0.2, sustain: 0.2, release: 0.6, gain: 0.25, filterHz: 2200 });
            break;
        default:
            break;
    }
}

function playRitualSfx(stage) {
    switch (stage) {
        case 1:
            // Spread frame: woody knock
            playTone({ freqs: 220.0, type: 'triangle', duration: 0.22, attack: 0.005, decay: 0.08, sustain: 0.2, release: 0.18, gain: 0.2, filterHz: 900, noise: 0.04 });
            break;
        case 2:
            // Wipe: brush swish
            playTone({ freqs: 330.0, type: 'sine', duration: 0.25, attack: 0.01, decay: 0.08, sustain: 0.1, release: 0.18, gain: 0.12, filterHz: 1400, noise: 0.22 });
            break;
        case 3:
            // Bloom: ink shimmer
            playTone({ freqs: [523.25, 659.25], type: 'sine', duration: 0.3, attack: 0.01, decay: 0.1, sustain: 0.2, release: 0.25, gain: 0.18, filterHz: 2000 });
            break;
        case 4:
            // Lift: lantern ignition
            playTone({ freqs: [440.0, 880.0], type: 'triangle', duration: 0.4, attack: 0.01, decay: 0.12, sustain: 0.2, release: 0.35, gain: 0.22, filterHz: 1700 });
            break;
        case 'release':
            // Release: airy drift
            playTone({ freqs: 330.0, type: 'sine', duration: 0.45, attack: 0.02, decay: 0.12, sustain: 0.2, release: 0.35, gain: 0.16, filterHz: 1800, noise: 0.18 });
            break;
        default:
            break;
    }
}

// 手势提示文字映射
const GESTURE_HINTS = {
    0: '双手张开向两侧推 · 制作鱼灯',
    1: '鱼灯完成 · 张手向上放生',
};
const RITUAL_CUES = {
    water: {
        gesture: 'release',
        kicker: '入场',
        title: '挥掌唤醒鱼影',
        subtitle: '张开手掌左右轻摆，沿着水面制造涟漪。',
    },
    fishing: {
        gesture: 'wipe',
        kicker: '钓鱼',
        title: '第一次捏合，放下鱼线',
        subtitle: '用拇指与食指捏合，放下鱼线。松开手指后，再次捏合即可提线。',
    },
    0: {
        gesture: 'spread',
        kicker: '制灯 · 非遗工艺',
        title: '双手向两侧推开',
        subtitle: '进入数字工艺场域，体验画模、扎架、扪纱、点睛四序粒子鱼灯。',
    },
    1: {
        gesture: 'release',
        kicker: '完成',
        title: '张开手掌向上抬',
        subtitle: '把鱼灯送回水面，完成放生。',
    },
    catch: {
        gesture: 'spread',
        kicker: '鱼影上岸',
        title: '阅读右侧知识卡片',
        subtitle: '点击「进入工艺体验」或双手推开，开始制灯。',
    },
    reveal: {
        gesture: 'bloom',
        kicker: '鱼影显形',
        title: '张手化光 · 握拳凝形',
        subtitle: '张开手掌让鱼影化作光点，握拳重新凝聚。光点完全散尽，或点击「开始制灯」，进入制灯。',
    },
};
// 麦克风/吹气检测
let micAnalyser = null;
let micDataArray = null;
let blowStrength = 0; // 0~1 吹气强度

// 页面阶段状态机
const PHASES = {
    WATER: 'water',       // 水面阶段：只有水波纹
    FISHING: 'fishing',   // 钓鱼阶段：鱼跃出水面
    CRAFTING: 'crafting', // 制灯阶段：形态切换
    LANTERN_RECEIVE: 'lanternReceive', // 鱼灯领取：单盏专属鱼灯
    LANTERN_SWARM: 'lanternSwarm',     // 鱼灯游群：十盏鱼灯巡游
};
let currentPhase = PHASES.WATER;
let phaseTransitioning = false;
let RITUAL_TIMEOUTS = [...DEFAULTS.ritualTimeouts];
let ritualTimeoutTimer = 0;
let ambientRippleTimer = 0;
let loaderReady = false;

function setLoaderProgress(pct, text) {
    const bar = document.getElementById('loader-progress');
    const sub = document.querySelector('.loader-sub');
    if (bar) bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    if (sub && text) sub.textContent = text;
}

function hideLoader() {
    if (loaderReady) return;
    loaderReady = true;
    setLoaderProgress(100, '准备就绪');
    const loader = document.getElementById('loader');
    if (!loader) return;
    loader.classList.add('hidden');
    setTimeout(() => loader.remove(), 900);
}

function resetRitualTimeout() {
    ritualTimeoutTimer = 0;
}

// ═══════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════
async function init() {
    // 场景
    scene = new THREE.Scene();
    // 不设置 scene.background - 让水波纹背景透出来
    scene.fog = new THREE.FogExp2(0x080810, 0.001);
    scene.add(new THREE.HemisphereLight(0xd8ecff, 0x2a1508, 1.6));
    const finalKeyLight = new THREE.DirectionalLight(0xffdf9a, 2.8);
    finalKeyLight.position.set(120, 150, 120);
    scene.add(finalKeyLight);
    const finalRimLight = new THREE.DirectionalLight(0x82d9ff, 1.8);
    finalRimLight.position.set(-140, 80, -120);
    scene.add(finalRimLight);

    // 相机
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 0, CONFIG.cameraZ);

    // 渲染器
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0); // 透明背景
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    document.getElementById('canvas-container').appendChild(renderer.domElement);

    // 水下特效系统
    bubbleSystem = new BubbleSystem(scene);
    splashSystem = new SplashSystem(scene);
    causticsEffect = new CausticsEffect(scene, { width: 350, height: 220, z: -8 });

    // 轨道控制（鼠标兜底操作）
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.3;
    controls.enablePan = false;
    controls.minDistance = 50;
    controls.maxDistance = 300;

    // 加载纹理
    await loadTextures();

    // 创建粒子系统
    createParticleSystem();

    // 创建鱼群（隐藏状态）
    createBoids();

    // 加载终局 3D 鱼模型（隐藏状态）
    loadFinalModel();

    // 添加水波纹背景粒子
    createBackgroundParticles();
    setLoaderProgress(98, '正在启动交互系统...');

    // 设置 UI 交互
    setupUI();

    // 设置手势识别
    setupMediaPipe();

    // 设置手机连接（PeerJS + QR码）
    setupPeerConnection();

    // 监听窗口
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('message', (event) => {
        if (event.origin !== location.origin) return;
        const { type } = event.data || {};
        if (type === 'craft-experience-complete') finishCraftVideoAndRevealLantern();
        if (type === 'craft-clap-exit') finishCraftVideoAndRevealLantern();
    });

    hideLoader();

    // 初始化阶段：从水面开始（加载完成后才显示引导）
    enterPhase(PHASES.WATER);

    // 渲染循环
    animate();
}

// ═══════════════════════════════════════════════════════
// 纹理加载
// ═══════════════════════════════════════════════════════
async function loadTextures() {
    setLoaderProgress(5, '正在初始化场景...');
    const loaderSub = document.querySelector('.loader-sub');
    fishPointClouds = await loadAllFishPointClouds(CONFIG.texSize, 90, (loaded, total) => {
        console.log(`[INFO] 点云采样: ${FISH_TYPES[loaded - 1].name} (${loaded}/${total})`);
        const pct = 5 + (loaded / total) * 55;
        setLoaderProgress(pct, `正在采样点云... ${loaded}/${total}`);
        if (loaderSub) loaderSub.textContent = `正在采样点云... ${loaded}/${total}`;
    });
    applyFishTextures(currentFishIndex, 0);
    console.log(`[INFO] 全部点云加载完成, ${FISH_TYPES.length} 种鱼, 每种 ${CONFIG.texSize * CONFIG.texSize} 粒子`);

    setLoaderProgress(65, '正在加载 3D 模型...');
    if (loaderSub) loaderSub.textContent = '正在加载五条鱼影...';
    await loadAllFishMeshes();
    setActiveFishMesh(0);
    await loadLanternMesh(currentFishIndex);

    setLoaderProgress(92, '正在准备水面特效...');
}

async function loadAllFishMeshes() {
    allFishMeshes = [];
    fishSwimCtrls = [];
    const NOSE_FLIPPED = [0, 3];
    const flipMatrix = new THREE.Matrix4().makeRotationY(Math.PI);
    for (let i = 0; i < FISH_TYPES.length; i++) {
        try {
            const mesh = await loadGLBMesh(FISH_TYPES[i].fish, 90);
            mesh.visible = false;
            if (NOSE_FLIPPED.includes(i)) {
                mesh.traverse((child) => {
                    if (child.isMesh && child.geometry) child.geometry.applyMatrix4(flipMatrix);
                });
            }
            scene.add(mesh);
            fishSwimCtrls.push(applySwimDeformation(mesh, {
                speed: 3.5, amplitude: 0.08, frequency: 2.0, tailBias: 2.2,
            }));
            allFishMeshes.push(mesh);
        } catch (e) {
            console.warn(`[WARN] 鱼影模型 ${FISH_TYPES[i].name} 加载失败`, e);
        }
    }
    console.log(`[INFO] 五种鱼型模板加载完成: ${allFishMeshes.length} 种`);
    spawnWaterFishInstances();
}

function spawnWaterFishInstances() {
    waterFishInstances.forEach((inst) => scene.remove(inst.mesh));
    waterFishInstances = [];
    targetFishInstance = null;

    FISH_INSTANCE_LAYOUT.forEach((layout) => {
        const template = allFishMeshes[layout.typeIndex];
        if (!template) return;
        const mesh = template.clone(true);
        mesh.visible = false;
        scene.add(mesh);
        waterFishInstances.push({
            mesh,
            typeIndex: layout.typeIndex,
            swimCtrl: applySwimDeformation(mesh, {
                speed: 3.0 + (layout.typeIndex % 3) * 0.3,
                amplitude: 0.06 + (layout.scaleMul - 0.13) * 0.4,
                frequency: 2.0,
                tailBias: 2.2,
            }),
            layout,
            isTarget: false,
        });
    });
    console.log(`[INFO] 水中鱼影实例: ${waterFishInstances.length} 条`);
}

function setActiveFishMesh(fishIdx) {
    if (!allFishMeshes[fishIdx]) return;
    currentFishIndex = fishIdx;
    if (targetFishInstance && targetFishInstance.typeIndex === fishIdx) {
        fishMeshGroup = targetFishInstance.mesh;
        fishSwimCtrl = targetFishInstance.swimCtrl;
    } else {
        fishMeshGroup = allFishMeshes[fishIdx];
        fishSwimCtrl = fishSwimCtrls[fishIdx];
    }
}

/**
 * 加载鱼灯 GLB 模型
 */
async function loadLanternMesh(fishIdx) {
    const fishType = FISH_TYPES[fishIdx];
    if (!fishType) return;
    if (lanternMeshGroup) {
        scene.remove(lanternMeshGroup);
        lanternMeshGroup = null;
    }
    try {
        lanternMeshGroup = cloneLanternForDance(await loadHighDetailLanternTemplate(fishIdx));
        lanternMeshGroup.userData._lanternBaseScale = lanternMeshGroup.scale.clone();
        lanternMeshGroup.visible = false;
        scene.add(lanternMeshGroup);
        console.log(`[INFO] 鱼灯模型加载完成: ${fishType.name}`);
    } catch (err) {
        console.warn('[WARN] 鱼灯模型加载失败:', err);
    }
}

/**
 * 应用指定鱼种的点云纹理到 uniforms
 * @param {number} fishIdx - 鱼种索引
 * @param {number} stageIdx - 0=鱼影, 1=鱼灯
 */
function applyFishTextures(fishIdx, stageIdx) {
    const data = fishPointClouds[fishIdx];
    if (!data) return;
    const stageKey = stageIdx === 0 ? 'fish' : 'lantern';
    pcTextures.posA = data[stageKey].posTex;
    pcTextures.posB = data[stageKey].posTex;
    pcTextures.colA = data[stageKey].colTex;
    pcTextures.colB = data[stageKey].colTex;
    if (uniforms) {
        uniforms.uPosA.value = pcTextures.posA;
        uniforms.uPosB.value = pcTextures.posB;
        uniforms.uColA.value = pcTextures.colA;
        uniforms.uColB.value = pcTextures.colB;
        uniforms.uMorph.value = 0.0;
    }
}

/**
 * 切换鱼种（保持当前阶段）
 */
async function switchFishType(newIndex) {
    if (isMorphing) return;
    if (newIndex < 0) newIndex = FISH_TYPES.length - 1;
    if (newIndex >= FISH_TYPES.length) newIndex = 0;
    currentFishIndex = newIndex;
    applyFishTextures(currentFishIndex, currentStage);
    
    // 同时更新网格模型
    setActiveFishMesh(newIndex);
    await loadLanternMesh(currentFishIndex);
    
    console.log(`[INFO] 切换鱼种: ${FISH_TYPES[currentFishIndex].name}`);
    // Toast提示
    showToast(`🐟 ${FISH_TYPES[currentFishIndex].name}`);
    // 更新 UI 提示
    const hintEl = document.getElementById('hint-text');
    if (hintEl && currentPhase === PHASES.CRAFTING) {
        hintEl.textContent = `${FISH_TYPES[currentFishIndex].name} · ${STAGES[currentStage].name}`;
    }
}

// ═══════════════════════════════════════════════════════
// 粒子系统（3D 点云 + 数据纹理驱动）
// ═══════════════════════════════════════════════════════
function createParticleSystem() {
    const count = CONFIG.texSize;
    const numParticles = count * count;

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(numParticles * 3); // 占位（实际位置由shader从纹理读取）
    const uvs = new Float32Array(numParticles * 2);

    // 生成索引 UV（用于在 shader 中查找数据纹理）
    let idx = 0;
    for (let y = 0; y < count; y++) {
        for (let x = 0; x < count; x++) {
            const u = (x + 0.5) / count;
            const v = (y + 0.5) / count;

            positions[idx * 3]     = 0;
            positions[idx * 3 + 1] = 0;
            positions[idx * 3 + 2] = 0;

            uvs[idx * 2]     = u;
            uvs[idx * 2 + 1] = v;

            idx++;
        }
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aUv', new THREE.BufferAttribute(uvs, 2));

    // 创建占位纹理（1×1 黑色 Float）
    const placeholderTex = new THREE.DataTexture(
        new Float32Array([0, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType
    );
    placeholderTex.needsUpdate = true;

    uniforms = {
        uTime:          { value: 0 },
        uPosA:          { value: pcTextures.posA || placeholderTex },
        uPosB:          { value: pcTextures.posB || placeholderTex },
        uColA:          { value: pcTextures.colA || placeholderTex },
        uColB:          { value: pcTextures.colB || placeholderTex },
        uMorph:         { value: 0.0 },
        uSize:          { value: CONFIG.pointSize },
        uBreathAmp:     { value: 0.02 },
        uFluidStrength: { value: 0.0 },
        uScatter:       { value: 0.0 },
        uHandWorld:     { value: new THREE.Vector3(0, 0, 0) },
        uWind:          { value: 0.0 },
        uTintColor:     { value: new THREE.Vector3(1, 1, 1) },
        uTintStrength:  { value: 0.0 },
        uThreshold:     { value: 0.85 },
    };

    const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: true,
        blending: THREE.NormalBlending,
    });

    particleSystem = new THREE.Points(geometry, material);
    particleSystem.frustumCulled = false;
    scene.add(particleSystem);
    // DEBUG
    window.__uniforms = uniforms;
    window.__pcTextures = pcTextures;
    window.__scene = scene;
    window.__particleSystem = particleSystem;
}

// ═══════════════════════════════════════════════════════
// 鱼群 Boids（InstancedMesh 方向感鱼形粒子）
// ═══════════════════════════════════════════════════════
let boidsPositions, boidsVelocities;
let boidsInstancedMesh;
const BOIDS_DUMMY = new THREE.Object3D();

function createBoids() {
    boidsGroup = new THREE.Group();
    boidsGroup.visible = false;
    scene.add(boidsGroup);

    const count = CONFIG.boidsCount;
    boidsPositions = new Float32Array(count * 3);
    boidsVelocities = [];

    for (let i = 0; i < count; i++) {
        boidsPositions[i * 3]     = (Math.random() - 0.5) * 200;
        boidsPositions[i * 3 + 1] = (Math.random() - 0.5) * 150;
        boidsPositions[i * 3 + 2] = (Math.random() - 0.5) * 60;

        boidsVelocities.push(new THREE.Vector3(
            (Math.random() - 0.5) * 0.8,
            (Math.random() - 0.5) * 0.8,
            (Math.random() - 0.5) * 0.4
        ));
    }

    // 鱼形几何：拉长的菱形 + 分叉尾
    const fishShape = new THREE.BufferGeometry();
    const verts = new Float32Array([
        // 身体（菱形）
        -1.2, 0, 0,    // 头
         0.0, 0.35, 0,  // 上
         0.8, 0, 0,     // 尾根
         0.0, -0.35, 0, // 下
        // 尾巴 (V形)
         0.8, 0, 0,     // 尾根
         1.5, 0.4, 0,   // 尾上
         1.2, 0, 0,     // 尾中
         1.5, -0.4, 0,  // 尾下
    ]);
    const indices = [
        0, 1, 2,  0, 2, 3,  // 身体
        4, 5, 6,  4, 6, 7,  // 尾巴
    ];
    fishShape.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    fishShape.setIndex(indices);
    fishShape.computeVertexNormals();

    // InstancedMesh 材质：半透明鱼形
    const fishMat = new THREE.MeshBasicMaterial({
        color: 0xcc8833,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending,
        depthWrite: false,
    });

    boidsInstancedMesh = new THREE.InstancedMesh(fishShape, fishMat, count);
    boidsInstancedMesh.frustumCulled = false;

    // 初始化实例颜色（暖金到朱红渐变）
    const color = new THREE.Color();
    for (let i = 0; i < count; i++) {
        const hue = 0.02 + Math.random() * 0.08;
        const sat = 0.75 + Math.random() * 0.25;
        const lum = 0.45 + Math.random() * 0.25;
        color.setHSL(hue, sat, lum);
        boidsInstancedMesh.setColorAt(i, color);
    }
    boidsInstancedMesh.instanceColor.needsUpdate = true;

    boidsGroup.add(boidsInstancedMesh);
}

function updateBoids(target, mode = 'follow') {
    if (!boidsGroup.visible || !boidsPositions || !boidsInstancedMesh) return;

    const count = CONFIG.boidsCount;
    const maxSpeed = mode === 'attract' ? 2.5 : 1.8;
    const maxForce = 0.04;
    const perceptionR = 35;

    for (let i = 0; i < count; i++) {
        const px = boidsPositions[i * 3];
        const py = boidsPositions[i * 3 + 1];
        const pz = boidsPositions[i * 3 + 2];
        const vel = boidsVelocities[i];

        let sepX = 0, sepY = 0, sepZ = 0;
        let aliX = 0, aliY = 0, aliZ = 0;
        let cohX = 0, cohY = 0, cohZ = 0;
        let total = 0;

        for (let j = 0; j < count; j += 3) {
            if (i === j) continue;
            const dx = px - boidsPositions[j * 3];
            const dy = py - boidsPositions[j * 3 + 1];
            const dz = pz - boidsPositions[j * 3 + 2];
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist > 0 && dist < perceptionR) {
                sepX += dx / dist; sepY += dy / dist; sepZ += dz / dist;
                aliX += boidsVelocities[j].x; aliY += boidsVelocities[j].y; aliZ += boidsVelocities[j].z;
                cohX += boidsPositions[j * 3]; cohY += boidsPositions[j * 3 + 1]; cohZ += boidsPositions[j * 3 + 2];
                total++;
            }
        }

        let ax = 0, ay = 0, az = 0;

        if (mode === 'scatter') {
            // 张手散开：从手掌位置推开
            const dx = px - target.x, dy = py - target.y, dz = pz - target.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.1;
            const repel = 8.0 / (dist * 0.1 + 1.0);
            ax += (dx / dist) * repel * 0.01;
            ay += (dy / dist) * repel * 0.01;
            az += (dz / dist) * repel * 0.005;
            // 保留弱分离力
            if (total > 0) {
                sepX /= total; sepY /= total; sepZ /= total;
                ax += sepX * maxForce * 2.0; ay += sepY * maxForce * 2.0; az += sepZ * maxForce * 2.0;
            }
        } else {
            // follow / attract 模式使用正常 boids 规则
            if (total > 0) {
                sepX /= total; sepY /= total; sepZ /= total;
                ax += sepX * maxForce * 3.5; ay += sepY * maxForce * 3.5; az += sepZ * maxForce * 3.5;
                aliX /= total; aliY /= total; aliZ /= total;
                ax += (aliX - vel.x) * maxForce * 1.5; ay += (aliY - vel.y) * maxForce * 1.5; az += (aliZ - vel.z) * maxForce * 1.5;
                cohX /= total; cohY /= total; cohZ /= total;
                ax += (cohX - px) * maxForce * 0.008; ay += (cohY - py) * maxForce * 0.008; az += (cohZ - pz) * maxForce * 0.008;
            }

            // 目标吸引力度
            const attractStrength = mode === 'attract' ? 0.006 : 0.002;
            ax += (target.x - px) * attractStrength;
            ay += (target.y - py) * attractStrength;
            az += (target.z - pz) * attractStrength * 0.5;
        }

        vel.x += ax; vel.y += ay; vel.z += az;
        const speed = vel.length();
        if (speed > maxSpeed) vel.multiplyScalar(maxSpeed / speed);
        // 最低速度（避免静止）
        if (speed < 0.3) vel.multiplyScalar(0.3 / speed);

        boidsPositions[i * 3]     += vel.x;
        boidsPositions[i * 3 + 1] += vel.y;
        boidsPositions[i * 3 + 2] += vel.z;

        // 边界环绕
        if (boidsPositions[i * 3] > 150) boidsPositions[i * 3] = -150;
        if (boidsPositions[i * 3] < -150) boidsPositions[i * 3] = 150;
        if (boidsPositions[i * 3 + 1] > 120) boidsPositions[i * 3 + 1] = -120;
        if (boidsPositions[i * 3 + 1] < -120) boidsPositions[i * 3 + 1] = 120;
        if (boidsPositions[i * 3 + 2] > 50) boidsPositions[i * 3 + 2] = -50;
        if (boidsPositions[i * 3 + 2] < -50) boidsPositions[i * 3 + 2] = 50;

        // 更新 InstancedMesh 矩阵（位置+朝向速度方向+大小随机）
        BOIDS_DUMMY.position.set(
            boidsPositions[i * 3],
            boidsPositions[i * 3 + 1],
            boidsPositions[i * 3 + 2]
        );
        // 朝向速度方向
        const angle = Math.atan2(vel.y, vel.x);
        BOIDS_DUMMY.rotation.set(0, 0, angle);
        // 大小变化 (3~7)
        const s = 3 + (i % 5);
        // 尾巴摆动
        const tailWag = Math.sin(clock.getElapsedTime() * 6 + i * 0.5) * 0.15;
        BOIDS_DUMMY.rotation.z += tailWag;
        BOIDS_DUMMY.scale.set(s, s * 0.7, 1);
        BOIDS_DUMMY.updateMatrix();
        boidsInstancedMesh.setMatrixAt(i, BOIDS_DUMMY.matrix);
    }

    boidsInstancedMesh.instanceMatrix.needsUpdate = true;
}

function loadFinalModel() {
    // 不再加载独立的终局模型，RELEASE 阶段直接复用 fishMeshGroup
    console.log('[INFO] 放生阶段将复用钓鱼阶段的鱼模型');
}

/**
 * 显示鱼灯GLB模型（制灯阶段后期 → 点亮鱼灯时调用）
 */
let lanternGlowProgress = 0;  // 0~1 点亮渐变进度
let lanternGlowing = false;   // 是否正在点亮
let lanternPointLight = null; // 内部点光源
let lanternDisplayFillLight = null;
let lanternDisplayBackLight = null;

function tuneLanternDisplayMaterials(group) {
    group.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => {
            mat.side = THREE.DoubleSide;
            mat.shadowSide = THREE.DoubleSide;
            mat.needsUpdate = true;
        });
    });
}

function setLanternDisplayLights(enabled) {
    if (lanternDisplayFillLight) lanternDisplayFillLight.intensity = 0;
    if (lanternDisplayBackLight) lanternDisplayBackLight.intensity = 0;
}

function showLanternModel() {
    if (!lanternMeshGroup) return;
    // 隐藏鱼，显示灯
    if (fishMeshGroup) fishMeshGroup.visible = false;
    lanternMeshGroup.visible = true;
    lanternMeshGroup.position.set(0, 0, 0);
    lanternMeshGroup.rotation.set(0, Math.PI / 2, 0);
    // 使用鱼灯自身经过包围盒适配后的尺寸，避免被鱼影缩放值压得过小
    if (lanternMeshGroup.userData._lanternBaseScale) {
        lanternMeshGroup.scale.copy(lanternMeshGroup.userData._lanternBaseScale);
    }
    tuneLanternDisplayMaterials(lanternMeshGroup);
    lanternModelFadeProgress = 0;
    lanternMeshGroup.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => {
            mat.transparent = true;
            mat.opacity = 0;
        });
    });
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.8;
    
    // 保留 GLB 原始材质，仅用柔和场景灯补光
    lanternGlowing = false;
    lanternGlowProgress = 0;
    // 添加内部暖光点光源
    if (!lanternPointLight) {
        lanternPointLight = new THREE.PointLight(0xffaa44, 0, 80);
        scene.add(lanternPointLight);
    }
    lanternPointLight.position.set(0, 0, 0);
    lanternPointLight.intensity = 0.62;
}

function hideLanternModel() {
    if (lanternMeshGroup) lanternMeshGroup.visible = false;
    setLanternDisplayLights(false);
}

function clearLanternDanceTimers() {
    if (lanternReadyTimer) {
        clearTimeout(lanternReadyTimer);
        lanternReadyTimer = null;
    }
    if (lanternDanceHintTimer) {
        clearTimeout(lanternDanceHintTimer);
        lanternDanceHintTimer = null;
    }
    if (lanternAutoReleaseTimer) {
        clearTimeout(lanternAutoReleaseTimer);
        lanternAutoReleaseTimer = null;
    }
    if (lanternParticleCompleteTimer) {
        clearTimeout(lanternParticleCompleteTimer);
        lanternParticleCompleteTimer = null;
    }
}

function clearLanternDanceGroup() {
    if (lanternDanceGroup) scene.remove(lanternDanceGroup);
    lanternDanceGroup = null;
    lanternDanceInstances = [];
    if (!lanternMeshGroup?.visible) setLanternDisplayLights(false);
}

function cloneLanternForDance(template) {
    const clone = template.clone(true);
    clone.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        obj.material = Array.isArray(obj.material)
            ? mats.map((mat) => mat.clone())
            : obj.material.clone();
    });
    tuneLanternDisplayMaterials(clone);
    return clone;
}

function getHighDetailLanternUrl(fishIdx) {
    return HIGH_DETAIL_LANTERN_MODELS[fishIdx] || HIGH_DETAIL_LANTERN_MODELS[0];
}

async function loadHighDetailLanternTemplate(fishIdx) {
    const url = getHighDetailLanternUrl(fishIdx);
    if (!highDetailLanternCache.has(url)) {
        highDetailLanternCache.set(url, loadGLBMesh(url, 90));
    }
    return highDetailLanternCache.get(url);
}

async function spawnLanternDanceGroup() {
    clearLanternDanceGroup();
    lanternDanceGroup = new THREE.Group();
    scene.add(lanternDanceGroup);
    setLanternDisplayLights(true);

    const templates = await Promise.all(FISH_TYPES.map((_, fishIdx) => loadHighDetailLanternTemplate(fishIdx)));
    const layouts = [
        [-96, 48, -26], [-66, 68, -10],
        [-42, 38, 2], [-12, 62, -22],
        [18, 44, -4], [48, 70, -18],
        [76, 40, -2], [102, 62, -30],
        [-82, 82, -38], [88, 86, -42],
    ];
    layouts.forEach((layout, index) => {
        const mesh = cloneLanternForDance(templates[index % FISH_TYPES.length]);
        const baseScale = mesh.scale.clone().multiplyScalar(0.24 + (index % 4) * 0.035);
        const side = index % 2 === 0 ? -1 : 1;
        const basePosition = new THREE.Vector3(layout[0], layout[1], layout[2]);
        mesh.visible = true;
        mesh.scale.copy(baseScale);
        mesh.position.set(basePosition.x + side * 105, basePosition.y + 42, basePosition.z - 18);
        mesh.rotation.set(0, Math.PI / 2 + side * 0.16, 0);
        lanternDanceGroup.add(mesh);
        lanternDanceInstances.push({
            mesh,
            basePosition,
            delay: index * 0.48,
            speed: 0.34 + (index % 5) * 0.075,
            floatAmp: 3.5 + (index % 3) * 1.6,
            swayAmp: 5.5 + (index % 4) * 2.1,
            phase: index * 0.82,
            rotationOffset: side * 0.16,
        });
    });
}

async function enterLanternDance() {
    if (lanternSummonStage !== 'model') return;
    lanternReadyTimer = null;
    currentPhase = PHASES.LANTERN_SWARM;
    updatePhaseIndicator();
    lanternSummonStage = 'danceArriving';
    lanternDanceReleased = false;
    lanternDanceReleaseProgress = 0;
    lanternMergeReturnScheduled = false;
    lanternDanceGesture = { sawFist: false, openFrames: 0 };
    if (lanternAutoReleaseTimer) {
        clearTimeout(lanternAutoReleaseTimer);
        lanternAutoReleaseTimer = null;
    }
    setLanternNightMode(true);
    if (particleSystem) particleSystem.visible = false;
    if (lanternMeshGroup) {
        lanternMeshGroup.visible = true;
        lanternMeshGroup.position.set(0, -24, 26);
        lanternMeshGroup.userData._danceBaseScale = (lanternMeshGroup.userData._lanternBaseScale || lanternMeshGroup.scale).clone();
        lanternMeshGroup.scale.copy(lanternMeshGroup.userData._danceBaseScale).multiplyScalar(0.72);
    }
    controls.autoRotate = false;
    camera.position.set(0, 10, 188);
    controls.target.set(0, 18, 0);
    controls.update();
    updateLanternSummonCopy('舞鱼灯 · 灯群巡游', 'TEN LANTERNS ARRIVE ACROSS THE NIGHT SKY');
    const summonBtn = document.getElementById('lantern-summon-btn');
    if (summonBtn) summonBtn.disabled = true;
    await spawnLanternDanceGroup();
    lanternDanceStartedAt = performance.now();
    // 入场后很快即可放飞（原 10s 死区缩短为 3.5s；且放飞手势在入场期间即可响应，见下）
    lanternDanceHintTimer = setTimeout(() => {
        lanternDanceHintTimer = null;
        if (lanternSummonStage !== 'danceArriving') return;
        lanternSummonStage = 'danceReleaseReady';
        updateLanternSummonCopy('请握拳张开手掌，放飞鱼灯', 'MAKE A FIST, THEN OPEN YOUR PALM TO RELEASE');
        if (summonBtn) {
            summonBtn.disabled = false;
            summonBtn.querySelector('span').textContent = '放飞鱼灯';
            summonBtn.querySelector('small').textContent = 'FIST THEN OPEN';
        }
    }, 3500);
}

function releaseUserLantern() {
    if (lanternSummonStage !== 'danceReleaseReady' || lanternDanceReleased) return;
    lanternDanceReleased = true;
    lanternSummonStage = 'danceMerging';
    lanternDanceReleaseProgress = 0;
    const summonBtn = document.getElementById('lantern-summon-btn');
    if (summonBtn) summonBtn.disabled = true;
    updateLanternSummonCopy('鱼灯汇入灯群，照亮水乡夜色', 'YOUR LANTERN JOINS THE DANCING LIGHTS');
    playRitualSfx('release');
}

function updateLanternDanceGesture(fingersUp) {
    if (lanternSummonStage !== 'danceReleaseReady') return;
    if (fingersUp <= 1) {
        lanternDanceGesture.sawFist = true;
        lanternDanceGesture.openFrames = 0;
        return;
    }
    if (lanternDanceGesture.sawFist && fingersUp >= 4) {
        lanternDanceGesture.openFrames++;
        if (lanternDanceGesture.openFrames >= 8) releaseUserLantern();
    }
}

function updateLanternDanceAnimation(dt, time) {
    if (!lanternSummonStage.startsWith('dance')) return;
    const elapsed = (performance.now() - lanternDanceStartedAt) / 1000;
    lanternDanceInstances.forEach((inst, index) => {
        const localTime = Math.max(0, elapsed - inst.delay);
        const arrival = Math.min(1, localTime / 2.8);
        const eased = 1 - Math.pow(1 - arrival, 3);
        const driftX = Math.sin(time * inst.speed + inst.phase) * inst.swayAmp;
        const driftY = Math.sin(time * inst.speed * 1.3 + inst.phase) * inst.floatAmp;
        const driftZ = Math.cos(time * inst.speed * 0.7 + inst.phase) * 2.5;
        const startX = inst.basePosition.x + (index % 2 === 0 ? -105 : 105);
        inst.mesh.position.set(
            THREE.MathUtils.lerp(startX, inst.basePosition.x, eased) + driftX,
            THREE.MathUtils.lerp(inst.basePosition.y + 42, inst.basePosition.y, eased) + driftY,
            THREE.MathUtils.lerp(inst.basePosition.z - 18, inst.basePosition.z, eased) + driftZ
        );
        if (lanternDanceReleased) {
            inst.mesh.position.y += lanternDanceReleaseProgress * 24;
            inst.mesh.position.z -= lanternDanceReleaseProgress * 10;
        }
        inst.mesh.rotation.y = Math.PI / 2 + inst.rotationOffset + Math.sin(time * inst.speed + inst.phase) * 0.2;
        inst.mesh.rotation.z = Math.sin(time * inst.speed * 1.2 + inst.phase) * 0.08;
    });

    if (!lanternMeshGroup?.visible) return;
    if (!lanternDanceReleased) {
        lanternMeshGroup.position.x = Math.sin(time * 0.55) * 4;
        lanternMeshGroup.position.y = -24 + Math.sin(time * 0.8) * 2.4;
        lanternMeshGroup.rotation.y = Math.PI / 2 + Math.sin(time * 0.5) * 0.12;
        return;
    }
    lanternDanceReleaseProgress = Math.min(1, lanternDanceReleaseProgress + dt / 4.8);
    const eased = 1 - Math.pow(1 - lanternDanceReleaseProgress, 3);
    lanternMeshGroup.position.lerpVectors(new THREE.Vector3(0, -24, 26), new THREE.Vector3(18, 63, -10), eased);
    lanternMeshGroup.scale.copy(lanternMeshGroup.userData._danceBaseScale).multiplyScalar(THREE.MathUtils.lerp(0.72, 0.34, eased));
    lanternMeshGroup.rotation.y = Math.PI / 2 + Math.sin(time * 0.9) * 0.16;
    if (lanternDanceReleaseProgress >= 1) {
        updateLanternSummonCopy('鱼灯已汇入灯群', 'THE LANTERNS DRIFT TOGETHER THROUGH THE NIGHT');
        if (!lanternMergeReturnScheduled) {
            lanternMergeReturnScheduled = true;
            setTimeout(() => {
                if (currentPhase === PHASES.LANTERN_SWARM) {
                    hideFinalModel();
                    currentStage = 0;
                    applyFishTextures(currentFishIndex, 0);
                    enterPhase(PHASES.WATER); // 循环回到水面
                }
            }, 4000);
        }
    }
}

async function showLanternReceivePreview() {
    clearLanternDanceTimers();
    clearLanternDanceGroup();
    setLanternNightMode(true);
    document.getElementById('ritual-cue')?.classList.add('is-hidden');
    hideAllFishMeshes();
    if (particleSystem) particleSystem.visible = false;
    if (fishSchool) { scene.remove(fishSchool.container); fishSchool = null; }
    await loadLanternMesh(currentFishIndex);
    lanternSummonStage = 'particles';
    lanternSummonSweep = { lastX: null, travel: 0, stableFrames: 0, lastAt: performance.now() };
    if (lanternMeshGroup) lanternMeshGroup.visible = false;
    document.body.classList.add('particle-receive-stage');
    await activateParticleScene();
    updateLanternSummonCopy('张手化光，凝成你的鱼灯', 'INTERACT WITH THE LIGHT FOR 15 SECONDS');
    const summonBtn = document.getElementById('lantern-summon-btn');
    if (summonBtn) {
        summonBtn.disabled = false;
        summonBtn.querySelector('span').textContent = '凝成鱼灯';
        summonBtn.querySelector('small').textContent = 'SHOW 3D LANTERN';
    }
    lanternParticleCompleteTimer = setTimeout(completeLanternParticleReceive, 15000);
}

function completeLanternParticleReceive() {
    if (lanternSummonStage !== 'particles') return;
    clearLanternDanceTimers();
    deactivateParticleScene();
    lanternSummonStage = 'model';
    showLanternModel();
    playRitualSfx(4);
    updateLanternSummonCopy('请比出 OK 手势，确认领取', 'MAKE AN OK GESTURE TO CLAIM');
    const summonBtn = document.getElementById('lantern-summon-btn');
    if (summonBtn) {
        summonBtn.disabled = false;
        summonBtn.querySelector('span').textContent = 'OK 确认领取';
        summonBtn.querySelector('small').textContent = 'CONFIRM TO ENTER LANTERN SWARM';
    }
}

async function showLanternSwarmPreview() {
    clearLanternDanceTimers();
    clearLanternDanceGroup();
    setLanternNightMode(true);
    document.getElementById('ritual-cue')?.classList.add('is-hidden');
    hideAllFishMeshes();
    if (particleSystem) particleSystem.visible = false;
    await loadLanternMesh(currentFishIndex);
    lanternSummonStage = 'model';
    showLanternModel();
    await enterLanternDance();
}

function showFinalModel() {
    isFinalModelVisible = true;
    isBoidsMode = false;
    if (particleSystem) particleSystem.visible = false;
    if (boidsGroup) boidsGroup.visible = false;
    // 显示 GLB 模型
    if (fishMeshGroup) {
        fishMeshGroup.visible = true;
        fishMeshGroup.position.set(0, 0, 0);
        fishMeshGroup.rotation.set(0, 0, 0);
    }
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.55;
    controls.target.set(0, 0, 0);
    camera.position.set(0, 18, 170);
    controls.update();

    const cue = document.getElementById('ritual-cue');
    if (cue) cue.classList.add('is-hidden');
}

function hideFinalModel() {
    isFinalModelVisible = false;
    if (fishMeshGroup) fishMeshGroup.visible = false;
    controls.target.set(0, 0, 0);
    controls.autoRotateSpeed = 0.3;
}

// ═══════════════════════════════════════════════════════
// 水波纹背景 + 浮游微光粒子
// ═══════════════════════════════════════════════════════
let rippleMesh, rippleScene, rippleCamera;
function createBackgroundParticles() {
    // 1. 浮游微光粒子（3D 场景内）
    const count = 3000;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        pos[i * 3]     = (Math.random() - 0.5) * 500;
        pos[i * 3 + 1] = (Math.random() - 0.5) * 500;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 400;
        sizes[i] = 0.3 + Math.random() * 1.2;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.PointsMaterial({
        size: 1.0,
        color: 0x4488bb,
        transparent: true,
        opacity: 0.32,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
    });

    ambientBackgroundParticles = new THREE.Points(geo, mat);
    ambientBackgroundParticles.frustumCulled = false;
    scene.add(ambientBackgroundParticles);

    // 2. 物理水波纹系统（屏幕空间，独立于3D场景）
    waterRipple = new WaterRipple(renderer, camera);
    waterRipple.loadWatercolorBackground('./assets/fishing-bg.png');
    waterRipple.resize(window.innerWidth, window.innerHeight);
    
    // 创建独立的正交场景用于渲染水波纹全屏背景
    rippleScene = new THREE.Scene();
    rippleCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    const rippleGeo = new THREE.PlaneGeometry(2, 2);
    const rippleMat = new THREE.MeshBasicMaterial({
        map: waterRipple.getOutputTexture(),
        depthWrite: false,
        depthTest: false,
    });
    rippleMesh = new THREE.Mesh(rippleGeo, rippleMat);
    rippleScene.add(rippleMesh);
}

// ═══════════════════════════════════════════════════════
// 形态切换
// ═══════════════════════════════════════════════════════
function switchToStage(targetIdx) {
    if (isMorphing) return;
    hideFinalModel();

    // 切入鱼群模式
    if (targetIdx >= STAGES.length) {
        // 进入鱼群前，显示鱼灯GLB模型作为过渡
        showLanternModel();
        enterBoidsMode();
        currentStage = targetIdx;
        updateUI();
        return;
    }

    // 退出鱼群模式
    if (isBoidsMode) {
        exitBoidsMode();
    }

    if (targetIdx === currentStage && !isBoidsMode) return;

    // 设置 morph: 从当前阶段 → 目标阶段
    const data = fishPointClouds[currentFishIndex];
    if (!data) return;
    const fromKey = currentStage === 0 ? 'fish' : 'lantern';
    const toKey = targetIdx === 0 ? 'fish' : 'lantern';

    isMorphing = true;
    morphProgress = 0;
    uniforms.uPosA.value = data[fromKey].posTex;
    uniforms.uPosB.value = data[toKey].posTex;
    uniforms.uColA.value = data[fromKey].colTex;
    uniforms.uColB.value = data[toKey].colTex;
    uniforms.uMorph.value = 0.0;
    currentStage = targetIdx;

    // TD粒子变形：显示粒子系统，隐藏GLB模型（变形期间用粒子表演）
    if (particleSystem) {
        particleSystem.visible = true;
        particleSystem.position.set(0, 0, 0);
    }
    if (fishMeshGroup) fishMeshGroup.visible = false;
    if (lanternMeshGroup) lanternMeshGroup.visible = false;

    // 背景暗化（让粒子更醒目）
    morphOverlay.style.opacity = '1';

    // 提示
    showToast('✨ 粒子化形中…', CONFIG.morphDuration * 1000);

    resetRitualTimeout();
    updateUI();
}

function enterBoidsMode() {
    enterPhase(PHASES.LANTERN_SWARM);
}

function exitBoidsMode() {
    enterPhase(PHASES.WATER);
}

/**
 * 仪式手势触发：切换到指定stage，或执行放生
 * @param {number|string} target - stage序号(1-4) 或 'release'
 */
function triggerRitualGesture(target) {
    if (target === 'release') {
        playRitualSfx('release');
        resetRitualTimeout();
        ritualCooldown = RITUAL_COOLDOWN;
        enterPhase(PHASES.LANTERN_RECEIVE);
        return;
    }

    // 只允许顺序推进（防止跳跃）
    if (target !== currentStage + 1) return;
    playRitualSfx(target);
    ritualCooldown = RITUAL_COOLDOWN;

    // 视觉反馈：短暂光晕闪烁
    const flash = document.createElement('div');
    flash.style.cssText = `
        position:fixed;inset:0;pointer-events:none;z-index:9999;
        background:radial-gradient(circle, rgba(255,240,200,0.18) 0%, transparent 70%);
        transition: opacity 0.6s ease-out; opacity:1;
    `;
    document.body.appendChild(flash);
    requestAnimationFrame(() => { flash.style.opacity = '0'; });
    setTimeout(() => flash.remove(), 700);

    switchToStage(target);

    const hintEl = document.getElementById('hint-text');
    const stageNames = ['', '骨架已展开', '竹纸已糊上', '色彩已点染', '🏮 鱼灯亮了！'];
    if (hintEl && stageNames[target]) hintEl.textContent = stageNames[target];

    updateGestureProgress(target);
    updateRitualCue(target);
}

let craftVideoFallbackTimer = null;
function cancelCraftVideoFallback() {
    if (craftVideoFallbackTimer) { clearTimeout(craftVideoFallbackTimer); craftVideoFallbackTimer = null; }
}

function enterCraftVideoExperience(forceOpen = false) {
    if (craftVideoOpen) return;
    if (lanternSummonStage !== 'idle') return;
    if (!forceOpen && (currentPhase !== PHASES.CRAFTING || currentStage !== 0)) return;

    craftVideoOpen = true;
    currentStage = 0;
    ritualCooldown = RITUAL_COOLDOWN;
    // 把摄像头让给制灯视频 iframe（单设备无法两路同开），其内部手势识别才能工作
    pauseHandInput();
    spreadGesture.prevDist = 0;
    spreadGesture.accumDelta = 0;
    playRitualSfx(1);

    const flash = document.createElement('div');
    flash.style.cssText = `
        position:fixed;inset:0;pointer-events:none;z-index:11999;
        background:radial-gradient(circle, rgba(255,240,200,0.22) 0%, transparent 70%);
        transition: opacity 0.6s ease-out; opacity:1;
    `;
    document.body.appendChild(flash);
    requestAnimationFrame(() => { flash.style.opacity = '0'; });
    setTimeout(() => flash.remove(), 700);

    const overlay = document.getElementById('craft-video-overlay');
    const frame = document.getElementById('craft-video-frame');
    if (!overlay || !frame) return;

    craftVideoUrl = craftVideoUrl || resolveCraftVideoUrl();
    // iframe 加载失败兜底：避免黑屏卡死（P0）
    frame.onerror = () => {
        console.warn('[WARN] 制灯视频 iframe 加载失败，自动跳过');
        showToast('⚠️ 工艺体验加载失败，已为你跳过', 2600);
        finishCraftVideoAndRevealLantern();
    };
    if (!frame.src || frame.src !== craftVideoUrl) {
        frame.src = craftVideoUrl;
    }

    document.getElementById('ritual-cue')?.classList.add('is-hidden');
    hideCraftReturnCue();
    overlay.classList.remove('is-hidden');
    overlay.setAttribute('aria-hidden', 'false');
    showToast('🏮 进入非遗鱼灯数字工艺体验 · 四步完成后自动领取鱼灯', 3200);

    cancelCraftVideoFallback();
}

function hideCraftReturnCue() {
    craftAwaitingClapReturn = false;
    document.getElementById('craft-return-cue')?.classList.remove('is-visible');
    clapReturnGesture.lastX = null;
    clapReturnGesture.travel = 0;
    clapReturnGesture.stable = 0;
}

function showCraftReturnCue() {
    craftAwaitingClapReturn = true;
    document.getElementById('craft-return-cue')?.classList.add('is-visible');
}

function closeCraftVideoOverlay() {
    craftVideoOpen = false;
    hideCraftReturnCue();
    const overlay = document.getElementById('craft-video-overlay');
    const frame = document.getElementById('craft-video-frame');
    if (overlay) {
        overlay.classList.add('is-hidden');
        overlay.setAttribute('aria-hidden', 'true');
    }
    if (frame) frame.src = 'about:blank';
    // 制灯视频结束/退出，主程序重新接管摄像头（领取鱼灯、升天等阶段的手势需要它）。
    // 稍等 iframe 释放摄像头后再取流，避免 NotReadableError（设备占用）。
    setTimeout(() => resumeHandInput(), 500);
}

function buildPerimeterScatterTexture(sourcePosTex, texSize) {
    const scatter = new Float32Array(texSize * texSize * 4);
    const count = texSize * texSize;
    for (let i = 0; i < count; i++) {
        const si = i * 4;
        const golden = i * 2.399963229728653;
        const ring = 86 + (i % 11) * 5.5 + (i % 7) * 3.2;
        scatter[si] = Math.cos(golden) * ring;
        scatter[si + 1] = ((i % 19) - 9) * 2.4;
        scatter[si + 2] = Math.sin(golden) * ring * 0.75;
        scatter[si + 3] = 1;
    }
    const tex = new THREE.DataTexture(scatter, texSize, texSize, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
}

function setLanternNightMode(enabled) {
    document.body.classList.toggle('lantern-night-stage', enabled);
    if (ambientBackgroundParticles) ambientBackgroundParticles.visible = !enabled;
    if (causticsEffect) causticsEffect.mesh.visible = !enabled;
    if (!enabled) {
        document.getElementById('lantern-summon-ui')?.classList.add('is-hidden');
    }
}

function updateLanternSummonCopy(title, subtitle) {
    const root = document.getElementById('lantern-summon-ui');
    const titleEl = document.getElementById('lantern-summon-title');
    const subEl = document.getElementById('lantern-summon-sub');
    if (root) root.classList.remove('is-hidden');
    updateLanternNameDisplay();
    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = subtitle;
}

function enterLanternSummonWaiting() {
    closeCraftVideoOverlay();
    catchShowcaseActive = false;
    hideFishKnowledgeCard();
    lanternSummonStage = 'waiting';
    currentPhase = PHASES.LANTERN_RECEIVE;
    updatePhaseIndicator();
    currentStage = 1;
    resetRitualTimeout();
    lanternSummonSweep = { lastX: null, travel: 0, stableFrames: 0, lastAt: performance.now() };
    setLanternNightMode(true);
    hideAllFishMeshes();
    hideLanternModel();
    if (particleSystem) particleSystem.visible = false;
    document.getElementById('ritual-cue')?.classList.add('is-hidden');
    const summonBtn = document.getElementById('lantern-summon-btn');
    if (summonBtn) summonBtn.disabled = false;
    updateLanternSummonCopy('左右挥动手掌，召唤你的鱼灯', 'SWEEP YOUR PALM TO SUMMON THE LANTERN');
}

function updateLanternSummonSweep(palmX, isOpenPalm) {
    // 领取鱼灯阶段(stage 'model')与旧的等待态('waiting')都接受「左右挥掌」推进
    const canSweep = lanternSummonStage === 'waiting';
    if (!canSweep || !isOpenPalm) {
        lanternSummonSweep.lastX = palmX;
        lanternSummonSweep.stableFrames = Math.max(0, lanternSummonSweep.stableFrames - 1);
        return;
    }
    const previousX = lanternSummonSweep.lastX;
    lanternSummonSweep.lastX = palmX;
    if (previousX === null) return;
    const dx = Math.abs(palmX - previousX);
    if (dx < 0.004) return;
    lanternSummonSweep.travel += dx;
    lanternSummonSweep.stableFrames++;
    if (lanternSummonSweep.travel >= 0.16 && lanternSummonSweep.stableFrames >= 8) {
        lanternSummonSweep.travel = 0;
        lanternSummonSweep.stableFrames = 0;
        handleSummonLantern();
    }
}

async function handleSummonLantern() {
    if (lanternSummonStage !== 'waiting') return;
    lanternSummonStage = 'particles';
    const summonBtn = document.getElementById('lantern-summon-btn');
    if (summonBtn) summonBtn.disabled = true;
    updateLanternSummonCopy('鱼影化灯，光点成形', 'THE FISH SHADOW BECOMES LIGHT');

    await loadLanternMesh(currentFishIndex);
    const data = fishPointClouds[currentFishIndex];
    if (!data || !particleSystem || !uniforms) {
        showLanternModel();
        return;
    }

    if (lanternRevealScatterTex) lanternRevealScatterTex.dispose();
    lanternRevealScatterTex = buildPerimeterScatterTexture(data.lantern.posTex, CONFIG.texSize);

    currentPhase = PHASES.LANTERN_RECEIVE;
    currentStage = 1;
    lanternRevealActive = true;
    isMorphing = true;
    morphProgress = 0;

    uniforms.uPosA.value = lanternRevealScatterTex;
    uniforms.uPosB.value = data.lantern.posTex;
    uniforms.uColA.value = data.lantern.colTex;
    uniforms.uColB.value = data.lantern.colTex;
    uniforms.uMorph.value = 0;

    particleSystem.visible = true;
    lanternRevealOriginalPointSize = uniforms.uSize.value;
    uniforms.uSize.value = Math.min(0.82, lanternRevealOriginalPointSize);
    particleSystem.position.set(0, 0, 0);
    if (fishMeshGroup) fishMeshGroup.visible = false;
    if (lanternMeshGroup) lanternMeshGroup.visible = false;
    morphOverlay.style.opacity = '1';

    controls.target.set(0, 0, 0);
    controls.autoRotate = false;
    camera.position.set(0, 10, 168);
    controls.update();

    updateGestureProgress(4);
    const info = FISH_KNOWLEDGE[currentFishIndex];
    const fishName = FISH_TYPES[currentFishIndex]?.name || '';
    showToast(`🏮 ${info?.shadowName || fishName} · 粒子正汇聚为鱼灯`, 3200);
    const hintEl = document.getElementById('hint-text');
    if (hintEl) hintEl.textContent = `${fishName}鱼灯成形中 · 四散粒子向心聚拢`;
    document.getElementById('gesture-progress')?.style.setProperty('display', 'flex');
}

function completeLanternRevealModel() {
    lanternOutlineHoldTimer = null;
    lanternRevealActive = false;
    lanternSummonStage = 'model';
    if (particleSystem) particleSystem.visible = false;
    if (lanternRevealOriginalPointSize !== null) {
        uniforms.uSize.value = lanternRevealOriginalPointSize;
        lanternRevealOriginalPointSize = null;
    }
    showLanternModel();
    playRitualSfx(4);
    clearLanternDanceTimers();
    updateLanternSummonCopy('你的鱼灯已生成', 'YOUR FISH LANTERN IS READY');
    const summonBtn = document.getElementById('lantern-summon-btn');
    if (summonBtn) {
        summonBtn.disabled = false;
        summonBtn.querySelector('span').textContent = 'OK 确认领取';
        summonBtn.querySelector('small').textContent = 'CONFIRM TO ENTER LANTERN SWARM';
    }
    const info = FISH_KNOWLEDGE[currentFishIndex];
    const hintEl = document.getElementById('hint-text');
    if (hintEl) hintEl.textContent = `${info?.shadowName || FISH_TYPES[currentFishIndex].name} · 鱼灯已点亮`;
    showToast('鱼灯已生成 · 张开手掌向上可放生', 2800);
}

function finishCraftVideoAndRevealLantern() {
    if (!craftVideoOpen && !craftAwaitingClapReturn) return;
    cancelCraftVideoFallback();
    closeCraftVideoOverlay();   // ★ 关闭叠层并复位 craftVideoOpen，避免残留卡死（P0）
    // 去掉旧的 DataTexture「鱼影化灯」粒子汇聚（与鱼影显形重复、风格不一致）：
    // 直接进入鱼灯领取，鱼灯成品直接显现，再进入升天。
    lanternSummonStage = 'idle';
    enterPhase(PHASES.LANTERN_RECEIVE);
}

function exitCraftVideoExperience() {
    finishCraftVideoAndRevealLantern();
}

function detectClapReturn(hand0) {
    if (!craftVideoOpen || !craftAwaitingClapReturn || !hand0) return;
    const x = hand0[9]?.x ?? hand0[0].x;
    if (clapReturnGesture.lastX === null) {
        clapReturnGesture.lastX = x;
        return;
    }
    const dx = Math.abs(x - clapReturnGesture.lastX);
    clapReturnGesture.lastX = x;
    if (dx < 0.004) {
        clapReturnGesture.stable = Math.max(0, clapReturnGesture.stable - 1);
        return;
    }
    clapReturnGesture.travel += dx;
    clapReturnGesture.stable++;
    if (clapReturnGesture.travel >= 0.16 && clapReturnGesture.stable >= 8) {
        clapReturnGesture.lastX = null;
        clapReturnGesture.travel = 0;
        clapReturnGesture.stable = 0;
        finishCraftVideoAndRevealLantern();
    }
}

function updateGestureProgress(stage) {
    document.querySelectorAll('.gesture-step').forEach((el, i) => {
        el.classList.toggle('done', i <= stage);
    });
}

function updateRitualCue(key, forceShow = true) {
    const cue = RITUAL_CUES[key];
    const root = document.getElementById('ritual-cue');
    if (!root) return;
    if (!loaderReady) {
        root.classList.add('is-hidden');
        return;
    }
    // 无对应cue或不强制显示时隐藏
    if (!cue || !forceShow) {
        root.classList.add('is-hidden');
        return;
    }

    const kicker = document.getElementById('ritual-kicker');
    const title = document.getElementById('ritual-title');
    const subtitle = document.getElementById('ritual-subtitle');
    const leftHand = document.querySelector('#ritual-gesture .hand-left');
    const rightHand = document.querySelector('#ritual-gesture .hand-right');
    if (kicker) kicker.textContent = cue.kicker;
    if (title) title.textContent = cue.title;
    if (subtitle) subtitle.textContent = cue.subtitle;
    if (leftHand) leftHand.textContent = cue.hands?.[0] || '✋';
    if (rightHand) rightHand.textContent = cue.hands?.[1] || '✋';
    root.dataset.cue = String(key);
    root.dataset.gesture = cue.gesture;
    root.classList.remove('is-hidden');
}

// ═══════════════════════════════════════════════════════
// 页面阶段管理
// ═══════════════════════════════════════════════════════
let fishShadowTime = 0;
let fishEmergProgress = 0;
let fishShadowOpacity = 0;   // 水下鱼影透明度
let fishAttracted = false;   // 鱼是否被吸引靠近
let fishAttractionTimer = 0; // 鱼影吸引累计时间
const WAKE_FISH_DURATION = 10;
let wakeFishActive = false;
let wakeFishElapsed = 0;
let waterIdleElapsed = 0; // 水面空闲计时：无人挥手时自动开始（无人值守吸引循环）
let wakeWaveState = { lastX: null, direction: 0, travel: 0, stableFrames: 0, lastRippleAt: 0 };

// 每种鱼型生成多条实例，分散在整个水域。
function buildFishInstanceLayout() {
    const layouts = [];
    const perType = 5;
    const scatter = (n, s) => {
        const v = Math.sin(n * 12.9898 + s * 78.233) * 43758.5453;
        return v - Math.floor(v);
    };
    // 六个松散区域，鱼影在区域内随机偏移，避免排成一行
    const zones = [
        { x: -58, z: -13 }, { x: -28, z: -17 }, { x: 8, z: -10 },
        { x: 38, z: -15 }, { x: 62, z: -11 }, { x: -12, z: -19 },
    ];
    let n = 0;
    for (let type = 0; type < FISH_TYPES.length; type++) {
        for (let k = 0; k < perType; k++) {
            const h1 = scatter(n, 1);
            const h2 = scatter(n, 2);
            const h3 = scatter(n, 3);
            const h4 = scatter(n, 4);
            const h5 = scatter(n, 5);
            const zone = zones[(type * 3 + k * 2) % zones.length];
            layouts.push({
                typeIndex: type,
                x: zone.x + (h1 - 0.5) * 42,
                z: zone.z + (h2 - 0.5) * 12,
                yShadow: -50 + h3 * 18,
                delay: h4 * 2.8,
                emergeDelay: h5 * 2.0,
                emergeDur: 0.7 + h1 * 0.55,
                fadeDur: 0.6 + h2 * 0.5,
                phase: type * 1.4 + k * 0.85 + h3 * 2.2,
                scaleMul: 0.11 + h4 * 0.038,
                rotY: -Math.PI / 2 + (h5 - 0.5) * 0.65,
            });
            n++;
        }
    }
    return layouts;
}
const FISH_INSTANCE_LAYOUT = buildFishInstanceLayout();
const WATER_SEQUENCE = {
    rippleOnly: 5.0,   // 纯涟漪体验
    shadowFade: 6.0,   // 鱼影渐显
    emerge: 5.0,       // 鱼影上浮
};
function waterSequenceEnd() {
    return WATER_SEQUENCE.rippleOnly + WATER_SEQUENCE.shadowFade + WATER_SEQUENCE.emerge;
}

function resetWakeFishStage() {
    wakeFishActive = false;
    wakeFishElapsed = 0;
    wakeWaveState = { lastX: null, direction: 0, travel: 0, stableFrames: 0, lastRippleAt: 0 };
}

function startWakeFishStage() {
    if (wakeFishActive || currentPhase !== PHASES.WATER) return;
    wakeFishActive = true;
    wakeFishElapsed = 0;
    fishAttractionTimer = 0;
    showToast('手掌左右轻摆，鱼影将在 10 秒内逐渐浮现', 1800);
}

function updateWakePalmWave(palmX, palmY, isOpenPalm) {
    if (currentPhase !== PHASES.WATER || !isOpenPalm) {
        wakeWaveState.lastX = palmX;
        wakeWaveState.stableFrames = Math.max(0, wakeWaveState.stableFrames - 1);
        return;
    }

    const previousX = wakeWaveState.lastX;
    wakeWaveState.lastX = palmX;
    if (previousX === null) return;

    const dx = palmX - previousX;
    const absDx = Math.abs(dx);
    if (absDx < 0.004) {
        wakeWaveState.stableFrames = Math.max(0, wakeWaveState.stableFrames - 1);
        return;
    }

    const direction = Math.sign(dx);
    if (wakeWaveState.direction && direction !== wakeWaveState.direction) {
        wakeWaveState.travel *= 0.45;
    }
    wakeWaveState.direction = direction;
    wakeWaveState.travel += absDx;
    wakeWaveState.stableFrames++;

    const now = performance.now();
    if (now - wakeWaveState.lastRippleAt > 150 && waterRipple) {
        waterRipple.addRippleAt(1 - palmX, 1 - palmY);
        wakeWaveState.lastRippleAt = now;
    }

    if (wakeWaveState.travel >= 0.12 && wakeWaveState.stableFrames >= 8) {
        startWakeFishStage();
        wakeWaveState.travel = 0;
        wakeWaveState.stableFrames = 0;
    }
}

function updateWakeFishShadows(progress, time) {
    const opacity = 0.18 + Math.min(1, progress) * 0.78;
    waterFishInstances.forEach((inst) => {
        const spot = inst.layout;
        const yPos = (spot.yShadow ?? -45) + progress * 20;
        styleFishShadow(inst.mesh, opacity, yPos, time, spot, spot.scaleMul);
        if (inst.swimCtrl) {
            inst.swimCtrl.uniforms.uSwimTime.value = time + spot.phase;
            inst.swimCtrl.uniforms.uSwimSpeed.value = 1.0 + (inst.typeIndex % 3) * 0.15;
            inst.swimCtrl.uniforms.uSwimAmp.value = 0.04 + progress * 0.08;
        }
    });
    fishShadowOpacity = opacity;
}

// 钓鱼状态机
const FISH_STATE = { SWIMMING: 0, APPROACHING: 1, BITING: 2, STRUGGLING: 3, CAUGHT: 4 };
let fishingState = FISH_STATE.SWIMMING;
let fishingStateTimer = 0;      // 当前状态持续时间
let fishingApproachDelay = 0;   // 自动靠近鱼钩的等待时间
let fishingStruggleCount = 0;   // 挣扎次数计数
let fishingReelAssist = 0;      // 捏合收线辅助（仅拉锯阶段）
let fishingLineDropped = false;
let fishingPinchCount = 0;
let fishingPinchStableFrames = 0;
let fishingPinchReleaseFrames = 0;
let fishingPinchReleased = true;
let craftFishYaw = -Math.PI / 2;  // 制灯阶段纯 Y 轴展示角
const FISHING_CAM_Z = 160;
const CATCH_FISH_OFFSET = { x: -42, y: 6, z: 0 };
const CATCH_CAM_TARGET = { x: -28, y: 4, z: 0 };

/** 与 FISH_TYPES 索引一一对应 */
const FISH_KNOWLEDGE = [
    { shadowName: '浮金之影', lanternName: '浮金鱼灯', meaning: '非遗新生、年节祝福、灯火流动、水乡丰收' },
    { shadowName: '狮子头鱼之影', lanternName: '狮子头鱼灯', meaning: '节庆、热闹、巡游气氛' },
    { shadowName: '石斑之影', lanternName: '石斑鱼灯', meaning: '富足、地方物产、丰收记忆' },
    { shadowName: '火鲤之影', lanternName: '火鲤鱼灯', meaning: '喜庆、丰收、年节热闹' },
    { shadowName: '鲮鱼之影', lanternName: '鲮鱼鱼灯', meaning: '水乡生活、渔业兴盛、顺德地方记忆' },
    { shadowName: '金鲤之影', lanternName: '金鲤鱼灯', meaning: '金光流转，传递吉祥，工艺永续，繁荣昌盛' },
    { shadowName: '海虾之影', lanternName: '海虾灯', meaning: '红火吉祥、五谷丰登、活力跃动' },
    { shadowName: '螃蟹之影', lanternName: '螃蟹灯', meaning: '喜气洋洋、纵横四海、节庆呈祥' },
];

let catchShowcaseActive = false;
let knowledgePreview = null;

function getCurrentLanternName() {
    const info = FISH_KNOWLEDGE[currentFishIndex];
    if (info?.lanternName) return info.lanternName;
    const path = FISH_TYPES[currentFishIndex]?.lantern || '';
    const file = path.split('/').pop()?.replace(/\.glb$/i, '') || FISH_TYPES[currentFishIndex]?.name || '鱼灯';
    return file.replace(/50000$/i, '');
}

function updateLanternNameDisplay() {
    const nameEl = document.getElementById('lantern-current-name');
    if (nameEl) nameEl.textContent = `当前获得：${getCurrentLanternName()}`;
}

function isOkConfirmHand(landmarks) {
    if (!landmarks) return false;
    const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
    const palm = dist3(landmarks[0], landmarks[9]) || 0.1;
    const okDist = dist3(landmarks[4], landmarks[8]);
    const middleOpen = dist3(landmarks[12], landmarks[9]) > palm * 0.62 || landmarks[12].y < landmarks[10].y;
    const ringOpen = dist3(landmarks[16], landmarks[13]) > palm * 0.45 || landmarks[16].y < landmarks[14].y;
    const pinkyOpen = dist3(landmarks[20], landmarks[17]) > palm * 0.42 || landmarks[20].y < landmarks[18].y;
    return okDist < Math.max(0.065, palm * 0.42) && middleOpen && ringOpen && pinkyOpen;
}

function updateOkConfirmGesture(isOk) {
    if (okConfirmGesture.cooldown > 0) okConfirmGesture.cooldown--;
    if (!isOk) {
        okConfirmGesture.frames = Math.max(0, okConfirmGesture.frames - 2);
        return;
    }
    okConfirmGesture.frames++;
    if (okConfirmGesture.frames < 8 || okConfirmGesture.cooldown > 0) return;
    okConfirmGesture.frames = 0;
    okConfirmGesture.cooldown = 45;
    if (currentPhase === PHASES.FISHING && catchShowcaseActive) {
        beginCraftFromCatch();
    } else if (currentPhase === PHASES.LANTERN_RECEIVE && lanternSummonStage === 'model') {
        enterLanternDance();
    }
}

// ── 粒子场景：实体鱼灯 ⇄ 粒子鱼影 溶解互动（来自 pointcloud-demo，已模块化） ──
async function activateParticleScene() {
    const layer = document.getElementById('particle-layer');
    if (!layer) return;
    const url = CRAFT_INDEX_TO_PARTICLE[currentFishIndex] || CRAFT_INDEX_TO_PARTICLE[0];
    layer.classList.add('active');
    particleSceneActive = true;
    try {
        const inLanternReceive = document.body.classList.contains('lantern-night-stage');
        if (!particleScene) {
            particleScene = new ParticleScene(layer, {
                viewShiftFrac: inLanternReceive ? 0 : 0.2,
                transparentBg: inLanternReceive,
            });
        }
        await particleScene.init();
        await particleScene.loadModel(url);
        // 默认呈现明亮的实体鱼（贴图+灯光，较亮）；张开手掌或拖滑块即化作粒子光点
        particleScene.setFxMode(revealFxMode);
        particleScene.setDissolve(0);
        syncRevealPanel();
        console.log('[INFO] 粒子场景已激活:', url);
    } catch (e) {
        console.warn('[WARN] 粒子场景加载失败:', e);
        deactivateParticleScene();
    }
}

let revealFxMode = 0;
// 同步底部粒子面板 UI（FX 高亮 + 溶解滑块）到当前粒子场景状态
function syncRevealPanel() {
    document.querySelectorAll('#reveal-panel .rp-fx button').forEach((b) => {
        b.classList.toggle('active', parseInt(b.dataset.fx) === revealFxMode);
    });
    const sl = document.getElementById('rp-dissolve');
    if (sl && particleScene) sl.value = String(particleScene.dissolveValue ?? 0.5);
}

function deactivateParticleScene() {
    particleSceneActive = false;
    document.body.classList.remove('particle-receive-stage');
    const layer = document.getElementById('particle-layer');
    if (layer) layer.classList.remove('active');
    if (particleScene) { particleScene.dispose(); particleScene = null; } // 释放显存 (B5)
}

// 「鱼影显形」推进：点「开始制灯」按钮，或无人值守空闲超时（有手交互时清零，绝不打断体验）
let revealIdle = 0;
const REVEAL_IDLE_AUTO_S = 5;
function scheduleRevealAutoAdvance() { revealIdle = 0; }
function cancelRevealAutoAdvance() { revealIdle = 0; }

function enterPhase(phase) {
    currentPhase = phase;
    phaseTransitioning = true;

    // 粒子「鱼影显形」环节在 startCatchShowcase 中激活；进入任何正式阶段都先释放，避免叠加冲突
    if (particleSceneActive) deactivateParticleScene();
    cancelRevealAutoAdvance();
    hideFishKnowledgeCard(); // 统一收起知识卡片，避免跳阶段后残留（P1）
    if (phase !== PHASES.CRAFTING) {
        clearLanternDanceTimers();
        clearLanternDanceGroup();
    }
    if (phase !== PHASES.CRAFTING || lanternSummonStage === 'idle') {
        setLanternNightMode(false);
    }
    const useWatercolorBackground = phase === PHASES.WATER || phase === PHASES.FISHING;
    document.body.classList.toggle('intro-water-stages', useWatercolorBackground);
    waterRipple?.setWatercolorMode(useWatercolorBackground);
    if (ambientBackgroundParticles) ambientBackgroundParticles.visible = !useWatercolorBackground;
    if (causticsEffect) causticsEffect.mesh.visible = !useWatercolorBackground;
    playPhaseSfx(phase);
    if (phase === PHASES.CRAFTING || phase === PHASES.LANTERN_RECEIVE || phase === PHASES.LANTERN_SWARM) resetRitualTimeout();
    hideFinalModel();
    
    // 统一隐藏所有 GLB，各阶段按需重新显示
    hideAllFishMeshes();
    if (lanternMeshGroup) lanternMeshGroup.visible = false;
    if (fishSchool) { scene.remove(fishSchool.container); fishSchool = null; }
    if (fishingLine) { scene.remove(fishingLine); fishingLine = null; }
    
    const hintEl = document.getElementById('hint-text');
    const panelBody = document.getElementById('panel-body');
    
    switch (phase) {
        case PHASES.WATER:
            // 水面阶段：隐藏鱼和鱼群，只有水波纹，偶有鱼影
            if (particleSystem) particleSystem.visible = false;
            if (fishMeshGroup) fishMeshGroup.visible = false;
            if (lanternMeshGroup) lanternMeshGroup.visible = false;
            if (boidsGroup) boidsGroup.visible = false;
            if (fishSchool) { scene.remove(fishSchool.container); fishSchool = null; }
            if (fishingLine) { scene.remove(fishingLine); fishingLine = null; }
            if (hintEl) hintEl.textContent = '单击或轻触水面制造涟漪';
            updateRitualCue('water');
            controls.autoRotate = false;
            fishShadowOpacity = 0;
            fishEmergProgress = 0;
            fishAttracted = false;
            fishAttractionTimer = 0;
            waterIdleElapsed = 0;
            resetWakeFishStage();
            resetFishMeshMaterials();
            hideAllFishMeshes();
            bgFishDartCtrls = [];
            setFishingBodyFx(null);
            break;
            
        case PHASES.FISHING:
            resetWakeFishStage();
            catchShowcaseActive = false;
            hideFishKnowledgeCard();
            controls.target.set(0, 0, 0);
            resetFishMeshMaterials();
            pickRandomCatchFish();
            initBackgroundFishControllers();
            if (particleSystem) particleSystem.visible = false;
            if (lanternMeshGroup) lanternMeshGroup.visible = false;
            if (fishSchool) { scene.remove(fishSchool.container); fishSchool = null; }
            allFishMeshes.forEach((mesh) => { mesh.visible = false; });
            waterFishInstances.forEach((inst) => {
                inst.mesh.visible = true;
                resetSingleFishMaterial(inst.mesh);
            });
            if (fishMeshGroup && targetFishInstance) {
                fishMeshGroup.rotation.set(0, -Math.PI / 2, 0);
                const baseScale = fishMeshGroup.userData._originalScale || fishMeshGroup.scale.x;
                fishMeshGroup.userData._originalScale = baseScale;
                fishMeshGroup.scale.setScalar(baseScale * 0.3);
            }
            fishDartCtrl = new FishDartController({ x: 55, y: 35 });
            if (targetFishInstance) {
                const spot = targetFishInstance.layout;
                fishDartCtrl.pos.set(spot.x, -8, spot.z);
            }
            fishMeshSwimTime = 0;
            if (boidsGroup) boidsGroup.visible = false;
            fishEmergProgress = 0;
            fishAttracted = false;
            // 初始化钓鱼状态机
            fishingState = FISH_STATE.SWIMMING;
            fishingStateTimer = 0;
            fishingReelAssist = 0;
            fishingLineDropped = false;
            fishingPinchCount = 0;
            fishingPinchStableFrames = 0;
            fishingPinchReleaseFrames = 0;
            fishingPinchReleased = true;
            fishingApproachDelay = 2 + Math.random() * 3; // 2~5秒后鱼开始靠近鱼钩
            fishingStruggleCount = 0;
            setFishingBodyFx(null);
            fishingStruggleCount = 0;
            if (hintEl) hintEl.textContent = '第一次捏合，放下鱼线';
            showToast('第一次捏合，放下鱼线', 2200);
            updateRitualCue('fishing');
            updateFishingCueStep(0);
            controls.autoRotate = false;
            controls.target.set(0, 0, 0);
            // 正面侧视：相机在正前方看鱼的侧面
            camera.position.set(0, 0, 160);
            controls.update();
            break;
            
        case PHASES.CRAFTING:
            // 制灯阶段直接打开黑色四步粒子工艺，不再显示旧蓝底活鱼预览。
            pendingCraftVideoOpen = true;
            if (particleSystem) particleSystem.visible = false;
            if (fishingLine) { scene.remove(fishingLine); fishingLine = null; }
            document.body.classList.remove('fishing-struggle', 'fishing-tension');
            if (fishSchool) { scene.remove(fishSchool.container); fishSchool = null; }
            hideAllFishMeshes();
            if (boidsGroup) boidsGroup.visible = false;
            isBoidsMode = false;
            if (hintEl) hintEl.textContent = '进入黑色粒子工艺体验';
            document.getElementById('ritual-cue')?.classList.add('is-hidden');
            controls.autoRotate = false;
            controls.autoRotateSpeed = 0;
            { const gp = document.getElementById('gesture-progress'); if (gp) gp.style.display = 'flex'; }
            updateGestureProgress(0);
            break;
            
        case PHASES.LANTERN_RECEIVE:
            showLanternReceivePreview();
            break;

        case PHASES.LANTERN_SWARM:
            showLanternSwarmPreview();
            break;
    }
    
    updatePhaseIndicator();
    setTimeout(() => {
        phaseTransitioning = false;
        if (pendingCraftVideoOpen && currentPhase === PHASES.CRAFTING) {
            pendingCraftVideoOpen = false;
            enterCraftVideoExperience(true);
        }
    }, 500);
}

function updatePhaseIndicator() {
    const phases = [PHASES.WATER, PHASES.FISHING, PHASES.CRAFTING, PHASES.LANTERN_RECEIVE, PHASES.LANTERN_SWARM];
    const idx = phases.indexOf(currentPhase);
    document.querySelectorAll('.dot').forEach((dot, i) => {
        dot.classList.toggle('active', i === idx);
    });
}

function advancePhase() {
    if (phaseTransitioning) return;

    switch (currentPhase) {
        case PHASES.WATER:
            enterPhase(PHASES.FISHING);
            break;
        case PHASES.FISHING:
            // 禁止手势/按键跳过：必须走完咬钩→挣扎→收线
            if (fishingState < FISH_STATE.CAUGHT) {
                showToast('🎣 请等待鱼咬钩并完成拉锯…', 1600);
                return;
            }
            enterPhase(PHASES.CRAFTING);
            break;
        case PHASES.CRAFTING:
            enterPhase(PHASES.LANTERN_RECEIVE);
            break;
        case PHASES.LANTERN_RECEIVE:
            enterPhase(PHASES.LANTERN_SWARM);
            break;
        case PHASES.LANTERN_SWARM:
            hideFinalModel();
            currentStage = 0;
            applyFishTextures(currentFishIndex, 0);
            enterPhase(PHASES.WATER);
            break;
    }
}

// ═══════════════════════════════════════════════════════
// 手部触控视觉（发光圆点，替代骨架线）
// ═══════════════════════════════════════════════════════
const HAND_GLOW_TIPS = [4, 8, 12, 16, 20];

function drawHandGlow(ctx, landmarks, w, h) {
    const getPos = (lm) => ({
        x: (1.0 - lm.x) * w,
        y: lm.y * h,
    });

    for (const idx of HAND_GLOW_TIPS) {
        const p = getPos(landmarks[idx]);
        const outerR = 10;
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, outerR);
        grad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
        grad.addColorStop(0.35, 'rgba(255, 255, 255, 0.35)');
        grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, outerR, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
    }

    // 掌心柔光
    const palm = getPos(landmarks[9]);
    const palmGrad = ctx.createRadialGradient(palm.x, palm.y, 0, palm.x, palm.y, 18);
    palmGrad.addColorStop(0, 'rgba(255, 255, 255, 0.18)');
    palmGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = palmGrad;
    ctx.beginPath();
    ctx.arc(palm.x, palm.y, 18, 0, Math.PI * 2);
    ctx.fill();
}

function pickRandomCatchFish() {
    if (!waterFishInstances.length) return;
    targetFishInstance = waterFishInstances[Math.floor(Math.random() * waterFishInstances.length)];
    currentFishIndex = targetFishInstance.typeIndex;
    waterFishInstances.forEach((inst) => { inst.isTarget = inst === targetFishInstance; });
    fishMeshGroup = targetFishInstance.mesh;
    fishSwimCtrl = targetFishInstance.swimCtrl;
    console.log(`[INFO] 本次随机目标: ${FISH_TYPES[currentFishIndex].name}（${waterFishInstances.length}条鱼影中的1条）`);
}

function hideAllFishMeshes() {
    allFishMeshes.forEach((mesh) => { mesh.visible = false; });
    waterFishInstances.forEach((inst) => { inst.mesh.visible = false; });
}

function resetFishMeshMaterials() {
    allFishMeshes.forEach((mesh) => resetSingleFishMaterial(mesh));
    waterFishInstances.forEach((inst) => resetSingleFishMaterial(inst.mesh));
}

function resetSingleFishMaterial(mesh) {
    mesh.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((mat) => {
            mat.transparent = false;
            mat.opacity = 1;
            mat.depthWrite = true;
            if (mat.userData._baseColor) mat.color.copy(mat.userData._baseColor);
        });
    });
}

function applyFishShadowMaterial(mesh, opacity, scaleMul = 0.22) {
    if (!mesh.userData._originalScale) mesh.userData._originalScale = mesh.scale.x;
    mesh.scale.setScalar(mesh.userData._originalScale * scaleMul);
    mesh.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((mat) => {
            if (!mat.userData._baseColor) mat.userData._baseColor = mat.color.clone();
            mat.transparent = true;
            mat.depthWrite = false;
            mat.opacity = opacity;
            mat.color.copy(mat.userData._baseColor).multiplyScalar(0.16 + opacity * 0.42);
        });
    });
}

function styleFishShadow(mesh, opacity, yPos, time, spot, scaleMul = 0.18) {
    mesh.visible = opacity > 0.03;
    if (!mesh.visible) return;
    const wobbleX = Math.sin(time * 0.45 + spot.phase) * 4;
    const wobbleZ = Math.cos(time * 0.38 + spot.phase * 1.3) * 3.5;
    mesh.position.set(spot.x + wobbleX, yPos, spot.z + wobbleZ);
    mesh.rotation.set(0, spot.rotY ?? -Math.PI / 2, 0);
    applyFishShadowMaterial(mesh, opacity, scaleMul);
}

function updateAllWaterFishShadows(t, time) {
    const shadowStart = WATER_SEQUENCE.rippleOnly;
    const shadowEnd = shadowStart + WATER_SEQUENCE.shadowFade;
    let maxOpacity = 0;

    waterFishInstances.forEach((inst) => {
        const spot = inst.layout;
        let opacity = 0;
        let yPos = spot.yShadow ?? -45;

        if (t >= shadowStart) {
            const appearT = Math.max(0, t - shadowStart - spot.delay);
            const fadeP = Math.min(1, appearT / (WATER_SEQUENCE.shadowFade * (spot.fadeDur ?? 0.85)));
            opacity = fadeP * 0.38;
            yPos = (spot.yShadow ?? -45) + fadeP * 5;
        }
        if (t >= shadowEnd) {
            const emergeT = Math.max(0, t - shadowEnd - (spot.emergeDelay ?? 0));
            const emergeP = Math.min(1, emergeT / (WATER_SEQUENCE.emerge * (spot.emergeDur ?? 1)));
            opacity = 0.38 + emergeP * 0.32;
            yPos = (spot.yShadow ?? -45) + 5 + emergeP * (22 + (spot.phase % 3) * 4);
        }

        maxOpacity = Math.max(maxOpacity, opacity);
        styleFishShadow(inst.mesh, opacity, yPos, time, spot, spot.scaleMul);

        if (inst.swimCtrl) {
            inst.swimCtrl.uniforms.uSwimTime.value = time + spot.phase;
            inst.swimCtrl.uniforms.uSwimSpeed.value = 1.0 + (inst.typeIndex % 3) * 0.15;
            inst.swimCtrl.uniforms.uSwimAmp.value = 0.035 + opacity * 0.08;
        }
    });
    fishShadowOpacity = maxOpacity;
}

function initBackgroundFishControllers() {
    bgFishDartCtrls = waterFishInstances.map((inst) => {
        if (inst.isTarget) return null;
        const spot = inst.layout;
        const ctrl = new FishDartController({ x: 90, y: 55 });
        ctrl.pos.set(spot.x, -14 + (inst.typeIndex % 4) * 3, spot.z);
        return ctrl;
    });
}

function updateBackgroundFish(dt, time) {
    waterFishInstances.forEach((inst, i) => {
        if (inst.isTarget) return;
        const ctrl = bgFishDartCtrls[i];
        if (!ctrl) return;
        ctrl.update(dt);
        inst.mesh.visible = true;
        inst.mesh.position.copy(ctrl.pos);
        inst.mesh.quaternion.copy(ctrl.quaternion);
        applyFishShadowMaterial(inst.mesh, 0.26 + (inst.typeIndex % 3) * 0.02, inst.layout.scaleMul * 0.92);
        if (inst.swimCtrl) {
            inst.swimCtrl.uniforms.uSwimTime.value = time + inst.layout.phase;
            inst.swimCtrl.uniforms.uSwimSpeed.value = 1.6 + (i % 5) * 0.12;
            inst.swimCtrl.uniforms.uSwimAmp.value = 0.05;
        }
    });
}

function hideNonTargetFish() {
    waterFishInstances.forEach((inst) => {
        if (!inst.isTarget) inst.mesh.visible = false;
    });
}

function ensureKnowledgePreview() {
    if (knowledgePreview) return knowledgePreview;
    const container = document.getElementById('knowledge-fish-canvas');
    if (!container) return null;

    const w = Math.max(container.clientWidth, 280);
    const h = Math.max(container.clientHeight, 180);
    const prevScene = new THREE.Scene();
    prevScene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a2a18, 1.1));
    const key = new THREE.DirectionalLight(0xffe8b8, 1.4);
    key.position.set(40, 60, 80);
    prevScene.add(key);
    const fill = new THREE.DirectionalLight(0xb9ebee, 0.75);
    fill.position.set(-55, 18, 45);
    prevScene.add(fill);
    const rim = new THREE.DirectionalLight(0xffcf87, 1.05);
    rim.position.set(-35, 40, -65);
    prevScene.add(rim);

    const prevCam = new THREE.PerspectiveCamera(32, w / h, 0.1, 500);
    prevCam.position.set(0, 8, 118);
    const prevRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    prevRenderer.setSize(w, h);
    prevRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    prevRenderer.outputColorSpace = THREE.SRGBColorSpace;
    prevRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    prevRenderer.toneMappingExposure = 1.08;
    container.appendChild(prevRenderer.domElement);

    const group = new THREE.Group();
    prevScene.add(group);
    knowledgePreview = { scene: prevScene, camera: prevCam, renderer: prevRenderer, group, yaw: -Math.PI / 2 };
    return knowledgePreview;
}

async function updateKnowledgeFishPreview(fishIndex) {
    const kp = ensureKnowledgePreview();
    if (!kp) return;
    while (kp.group.children.length) kp.group.remove(kp.group.children[0]);
    try {
        const mesh = await loadGLBMesh(FISH_TYPES[fishIndex].fish, 88);
        mesh.rotation.set(0, kp.yaw, 0);
        mesh.traverse((obj) => {
            if (!obj.isMesh || !obj.material) return;
            obj.material = obj.material.clone();
            if (obj.material.emissive) {
                obj.material.emissive.setRGB(0.18, 0.11, 0.045);
                obj.material.emissiveIntensity = 0.12;
            }
            if ('roughness' in obj.material) obj.material.roughness = Math.min(obj.material.roughness, 0.72);
        });
        kp.group.add(mesh);
        kp.mesh = mesh;
    } catch (err) {
        console.warn('[WARN] 知识卡片模型加载失败', err);
    }
}

function showFishKnowledgeCard(fishIndex) {
    const info = FISH_KNOWLEDGE[fishIndex];
    const card = document.getElementById('fish-knowledge-card');
    if (!info || !card) return;

    const titleEl = document.getElementById('fkc-title');
    const meaningEl = document.getElementById('fkc-meaning');
    if (titleEl) titleEl.textContent = `你钓起了「${info.shadowName}」`;
    if (meaningEl) meaningEl.textContent = info.meaning;

    updateKnowledgeFishPreview(fishIndex);
    card.classList.remove('is-hidden');
    card.classList.add('is-visible');
    card.setAttribute('aria-hidden', 'false');
    document.body.classList.add('catch-showcase');
}

function hideFishKnowledgeCard() {
    const card = document.getElementById('fish-knowledge-card');
    if (card) {
        card.classList.add('is-hidden');
        card.classList.remove('is-visible');
        card.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('catch-showcase');
}

function startCatchShowcase() {
    if (catchShowcaseActive || !fishMeshGroup) return;
    catchShowcaseActive = true;

    if (fishingLine) fishingLine.visible = false;
    hideNonTargetFish();
    resetSingleFishMaterial(fishMeshGroup);
    if (fishingPinchCount >= 2) makeCaughtFishGlow();

    const origScale = fishMeshGroup.userData._originalScale || fishMeshGroup.scale.x;
    fishMeshGroup.userData._originalScale = origScale;
    fishMeshGroup.scale.setScalar(origScale);
    fishMeshGroup.visible = true;
    craftFishYaw = -Math.PI / 2;
    fishMeshGroup.position.set(CATCH_FISH_OFFSET.x, CATCH_FISH_OFFSET.y, CATCH_FISH_OFFSET.z);
    fishMeshGroup.quaternion.identity();
    fishMeshGroup.rotation.set(0, craftFishYaw, 0);

    controls.target.set(CATCH_CAM_TARGET.x, CATCH_CAM_TARGET.y, CATCH_CAM_TARGET.z);
    controls.update();

    showFishKnowledgeCard(currentFishIndex);

    spreadGesture.prevDist = 0;
    spreadGesture.accumDelta = 0;
    document.getElementById('ritual-cue')?.classList.add('is-hidden');

    const hintEl = document.getElementById('hint-text');
    if (hintEl) hintEl.textContent = '鱼影已上岸 · 查看卡片后进入工艺体验';

    cancelRevealAutoAdvance();
}

function beginCraftFromCatch() {
    cancelRevealAutoAdvance();
    // Fix5：先拉起制灯叠层的暗底，覆盖切换瞬间可能露出的蓝色水波背景
    const overlay = document.getElementById('craft-video-overlay');
    if (overlay) { overlay.classList.remove('is-hidden'); overlay.setAttribute('aria-hidden', 'false'); }
    if (particleSceneActive) deactivateParticleScene(); // 结束鱼影显形，释放显存
    hideFishKnowledgeCard();
    catchShowcaseActive = false;
    if (fishingLine) {
        scene.remove(fishingLine);
        fishingLine = null;
    }
    controls.target.set(0, 0, 0);
    pendingCraftVideoOpen = true;
    if (currentPhase === PHASES.CRAFTING) {
        pendingCraftVideoOpen = false;
        enterCraftVideoExperience(true);
    } else {
        enterPhase(PHASES.CRAFTING);
    }
}

function setFishingBodyFx(mode) {
    document.body.classList.remove('fishing-struggle', 'fishing-tension');
    if (mode === 'tension') document.body.classList.add('fishing-tension');
    if (mode === 'struggle') document.body.classList.add('fishing-struggle');
}

// ═══════════════════════════════════════════════════════
// MediaPipe 手势
// ═══════════════════════════════════════════════════════
function handleFirstFishingPinch() {
    if (fishingLineDropped || currentPhase !== PHASES.FISHING) return;
    fishingLineDropped = true;
    fishingPinchCount = 1;
    fishingState = FISH_STATE.SWIMMING;
    fishingStateTimer = 0;
    createFishingLine();
    waterRipple?.addRippleAt(0.58, 0.46);
    const hintEl = document.getElementById('hint-text');
    if (hintEl) hintEl.textContent = '再次捏合，提起鱼线';
    updateFishingCueStep(1);
    showToast('再次捏合，提起鱼线 · PINCH AGAIN TO LIFT THE LINE', 2200);
}

function updateFishingCueStep(step) {
    const root = document.getElementById('ritual-cue');
    if (!root || currentPhase !== PHASES.FISHING) return;
    root.dataset.fishingStep = String(step);
    const title = document.getElementById('ritual-title');
    const subtitle = document.getElementById('ritual-subtitle');
    if (step === 0) {
        if (title) title.textContent = '第一次捏合，放下鱼线';
        if (subtitle) subtitle.textContent = '用拇指与食指捏合，放下鱼线。松开手指后，再次捏合即可提线。';
    } else {
        if (title) title.textContent = '再次捏合，提起鱼线';
        if (subtitle) subtitle.textContent = '鱼线已经垂入水面。松开手指，再捏合一次，将鱼影提起。';
    }
}

function makeCaughtFishGlow() {
    fishMeshGroup?.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => {
            if (!mat.emissive) return;
            mat.emissive.setRGB(0.34, 0.2, 0.06);
            mat.emissiveIntensity = 0.42;
        });
    });
}

function handleSecondFishingPinch() {
    if (!fishingLineDropped || fishingPinchCount !== 1 || currentPhase !== PHASES.FISHING) return;
    fishingPinchCount = 2;
    fishingState = FISH_STATE.CAUGHT;
    fishingStateTimer = 0;
    setFishingBodyFx(null);
    hideNonTargetFish();
    resetSingleFishMaterial(fishMeshGroup);
    makeCaughtFishGlow();
    if (fishDartCtrl) {
        fishDartCtrl.pos.set(15, 2, fishDartCtrl.pos.z);
        fishDartCtrl.heading = Math.PI / 2;
    }
    waterRipple?.addRippleAt(0.58, 0.48);
    if (splashSystem && fishDartCtrl) {
        splashSystem.burst(fishDartCtrl.pos.x, fishDartCtrl.pos.y, { count: 42, power: 100, color: [0.72, 0.96, 1.0] });
    }
    const hintEl = document.getElementById('hint-text');
    if (hintEl) hintEl.textContent = '鱼影已上岸 · 请阅读结果卡片';
    startCatchShowcase();
}

function handleFishingPinchFrame(isPinching) {
    if (currentPhase !== PHASES.FISHING || fishingState >= FISH_STATE.CAUGHT) return;
    if (!isPinching) {
        fishingPinchStableFrames = 0;
        fishingPinchReleaseFrames++;
        if (fishingPinchReleaseFrames >= 6) fishingPinchReleased = true;
        return;
    }
    fishingPinchReleaseFrames = 0;
    if (!fishingPinchReleased) return;
    fishingPinchStableFrames++;
    if (fishingPinchStableFrames < 8) return;
    fishingPinchStableFrames = 0;
    fishingPinchReleased = false;
    if (fishingPinchCount === 0) handleFirstFishingPinch();
    else if (fishingPinchCount === 1) handleSecondFishingPinch();
}

function setupMediaPipe() {
    const video = document.getElementById('camera-video');
    const canvas = document.getElementById('camera-canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 160;
    canvas.height = 120;

    // 手势结果处理：保持原五阶段手势解析逻辑不变，
    // 由 src/hand-input.js (tasks-vision) 通过兼容结构驱动。
    function onHandResults(results) {
            // 绘制摄像头预览（隐藏的 canvas，仅内部使用）
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

            // 获取全屏骨骼画布
            const skelCanvas = document.getElementById('hand-skeleton');
            const skelCtx = skelCanvas.getContext('2d');
            skelCanvas.width = window.innerWidth;
            skelCanvas.height = window.innerHeight;
            skelCtx.clearRect(0, 0, skelCanvas.width, skelCanvas.height);

            if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
                const landmarks = results.multiHandLandmarks[0];
                handData.detected = true;

                // 手掌中心 (wrist)
                handData.palmX = landmarks[0].x - 0.5;  // -0.5~0.5
                handData.palmY = landmarks[0].y - 0.5;

                const allLandmarks = results.multiHandLandmarks;
                const twoHands = allLandmarks.length >= 2;
                const hand0 = allLandmarks[0];
                const hand1 = twoHands ? allLandmarks[1] : null;

                if (craftVideoOpen) detectClapReturn(hand0);

                // 注意：鱼影显形环节「双手张开」本身就是溶解互动，不能再用「双手推开」推进
                // （会一张手就误触发跳转）。推进改由：完全化光保持 / 点按按钮 / 长时间超时。

                // 手指伸展计数（判断张手/握拳），需先于仪式手势检测更新
                {
                    let fingersUp = 0;
                    // 拇指：指尖x超过指根x（考虑左右手差异，用距手腕的距离判断）
                    const thumbTip = landmarks[4], thumbIP = landmarks[3];
                    const wristX = landmarks[0].x;
                    if (Math.abs(thumbTip.x - wristX) > Math.abs(thumbIP.x - wristX)) fingersUp++;
                    // 其他4指：指尖y < 近指节y（相对手掌方向）
                    if (landmarks[8].y < landmarks[6].y) fingersUp++;   // 食指
                    if (landmarks[12].y < landmarks[10].y) fingersUp++; // 中指
                    if (landmarks[16].y < landmarks[14].y) fingersUp++; // 无名指
                    if (landmarks[20].y < landmarks[18].y) fingersUp++; // 小指
                    handData.fingersUp = fingersUp;
                }
                updateWakePalmWave(landmarks[9].x, landmarks[9].y, handData.fingersUp >= 3);
                updateLanternSummonSweep(landmarks[9].x, handData.fingersUp >= 3);
                updateLanternDanceGesture(handData.fingersUp);
                updateOkConfirmGesture(isOkConfirmHand(landmarks));

                // ── 仪式手势检测（制灯/放生阶段）────────────────────
                if (ritualCooldown > 0) ritualCooldown--;

                // 更新第二只手骨骼绘制（已在外层处理）

                if (currentPhase === PHASES.CRAFTING && !isMorphing && ritualCooldown === 0 && !craftVideoOpen) {

                    // ── 手势1：双手向两侧推开 → 进入 outputs-video 非遗工艺体验 ──
                    if (currentStage === 0) {
                        if (twoHands) {
                            const x0 = hand0[0].x, x1 = hand1[0].x;
                            const dist = Math.abs(x0 - x1);
                            const delta = dist - spreadGesture.prevDist;
                            if (delta > 0.002) { // 持续扩大
                                spreadGesture.accumDelta += delta;
                            } else {
                                spreadGesture.accumDelta = Math.max(0, spreadGesture.accumDelta - 0.005);
                            }
                            spreadGesture.prevDist = dist;
                            if (spreadGesture.accumDelta > 0.12) {
                                enterCraftVideoExperience();
                                spreadGesture.accumDelta = 0;
                            }
                        } else {
                            spreadGesture.accumDelta = Math.max(0, spreadGesture.accumDelta - 0.01);
                        }
                    }

                    // ── 手势2：单手从左到右缓慢抹过 → stage 1→2（骨架→糊纸）──
                    if (currentStage === 1) {
                        const px = handData.palmX; // -0.5~0.5
                        if (!wipeGesture.traveling && px < -0.2) {
                            // 手在左侧，开始抹
                            wipeGesture.traveling = true;
                            wipeGesture.startX = px;
                            wipeGesture.accumX = 0;
                        }
                        if (wipeGesture.traveling) {
                            const dx = px - (wipeGesture.startX + wipeGesture.accumX);
                            if (dx > 0) wipeGesture.accumX += dx; // 只累计向右的位移
                            if (wipeGesture.accumX > 0.35) {
                                triggerRitualGesture(2);
                                wipeGesture.traveling = false;
                                wipeGesture.accumX = 0;
                                wipeGesture.startX = null;
                            }
                        }
                        // 手移回左侧重置
                        if (px < -0.25) {
                            wipeGesture.traveling = false;
                            wipeGesture.accumX = 0;
                        }
                    }

                    // ── 手势3：握拳→张开 → stage 2→3（糊纸→上色）──
                    if (currentStage === 2) {
                        const fu = handData.fingersUp;
                        const isFistLike = fu <= 2;
                        const isOpenLike = fu >= 3;
                        if (isFistLike) {
                            bloomGesture.holdFistTime++;
                        } else {
                            if (bloomGesture.holdFistTime > 0) bloomGesture.holdFistTime--;
                        }
                        if (bloomGesture.holdFistTime > 10) {
                            bloomGesture.wasFist = true;
                        }
                        if (bloomGesture.wasFist && isOpenLike) {
                            triggerRitualGesture(3);
                            bloomGesture.wasFist = false;
                            bloomGesture.holdFistTime = 0;
                        }
                    }

                    // ── 手势4：双手靠近→向上托起 → stage 3→4（上色→鱼灯）──
                    if (currentStage === 3) {
                        if (twoHands) {
                            const x0 = hand0[0].x, x1 = hand1[0].x;
                            const y0 = hand0[0].y, y1 = hand1[0].y;
                            const hdist = Math.abs(x0 - x1);
                            const avgY = (y0 + y1) / 2;
                            if (hdist < 0.28) {
                                liftGesture.closeTime++;
                                if (liftGesture.closeTime > 6 && !liftGesture.wasClose) {
                                    liftGesture.wasClose = true;
                                    liftGesture.startY = avgY;
                                    liftGesture.riseAccum = 0;
                                }
                                if (liftGesture.wasClose && liftGesture.startY !== null) {
                                    const rise = liftGesture.startY - avgY; // Y减小=向上
                                    if (rise > liftGesture.riseAccum) liftGesture.riseAccum = rise;
                                    if (liftGesture.riseAccum > 0.08) {
                                        triggerRitualGesture(4);
                                        liftGesture.wasClose = false;
                                        liftGesture.closeTime = 0;
                                        liftGesture.startY = null;
                                        liftGesture.riseAccum = 0;
                                    }
                                }
                            } else {
                                liftGesture.closeTime = Math.max(0, liftGesture.closeTime - 2);
                                if (liftGesture.closeTime === 0) {
                                    liftGesture.wasClose = false;
                                    liftGesture.startY = null;
                                    liftGesture.riseAccum = 0;
                                }
                            }
                        } else {
                            liftGesture.closeTime = 0;
                            liftGesture.wasClose = false;
                            liftGesture.startY = null;
                            liftGesture.riseAccum = 0;
                        }
                    }
                }

                // ── 放生手势：张开五指+手腕上移 → 放生完成 ──
                if (
                    ritualCooldown === 0 &&
                    (
                        false ||
                        (currentPhase === PHASES.CRAFTING && currentStage === 4)
                    )
                ) {
                    const fu = handData.fingersUp;
                    const py = handData.palmY; // -0.5~0.5，负=上方
                    if (fu >= 4) {
                        releaseGesture.openTime++;
                        if (releaseGesture.openTime > 8 && releaseGesture.startY === null) {
                            releaseGesture.startY = py;
                            releaseGesture.riseAccum = 0;
                        }
                        if (releaseGesture.startY !== null) {
                            const rise = releaseGesture.startY - py; // palmY减小=手上移
                            if (rise > releaseGesture.riseAccum) releaseGesture.riseAccum = rise;
                            if (releaseGesture.riseAccum > 0.08) {
                                triggerRitualGesture('release');
                                releaseGesture.openTime = 0;
                                releaseGesture.startY = null;
                                releaseGesture.riseAccum = 0;
                            }
                        }
                    } else {
                        releaseGesture.openTime = Math.max(0, releaseGesture.openTime - 2);
                        if (releaseGesture.openTime === 0) {
                            releaseGesture.startY = null;
                            releaseGesture.riseAccum = 0;
                        }
                    }
                }

                // ── 更新提示文字 ──
                if (currentPhase === PHASES.CRAFTING && !isMorphing) {
                    const hint = GESTURE_HINTS[currentStage] || '';
                    const hintEl = document.getElementById('hint-text');
                    if (hintEl && hint) hintEl.textContent = hint;
                }
                if (currentPhase === PHASES.LANTERN_SWARM) {
                    const hintEl = document.getElementById('hint-text');
                    if (hintEl) hintEl.textContent = '鱼灯游群 · 握拳后张开放飞专属鱼灯';
                }

                // 在全屏画布上绘制发光触控点
                drawHandGlow(skelCtx, landmarks, skelCanvas.width, skelCanvas.height);
                
                // 水面阶段：仅用食指触发单点涟漪，避免五指尖同时扰动
                if (waterRipple) {
                    if (currentPhase === PHASES.WATER) {
                        const fingerData = [{
                            x: 1.0 - landmarks[8].x,
                            y: 1.0 - landmarks[8].y,
                            active: true,
                        }];
                        waterRipple.setFingerPositions(fingerData);
                    } else {
                        const fingerIndices = [4, 8, 12, 16, 20];
                        const fingerData = fingerIndices.map(idx => ({
                            x: 1.0 - landmarks[idx].x,
                            y: 1.0 - landmarks[idx].y,
                            active: true,
                        }));
                        waterRipple.setFingerPositions(fingerData);
                    }
                }
                
                // 如果有第二只手
                if (results.multiHandLandmarks.length > 1) {
                    drawHandGlow(skelCtx, results.multiHandLandmarks[1], skelCanvas.width, skelCanvas.height);
                }

                // 捏合检测 (拇指4 vs 食指8) - 增大阈值防止误触
                const thumb = landmarks[4];
                const index = landmarks[8];
                const dx = thumb.x - index.x;
                const dy = thumb.y - index.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                handData.pinchDist = dist;

                // 捏合阈值
                if (dist < 0.04) {
                    if (!handData.isPinching && handData.pinchCooldown <= 0) {
                        handData.isPinching = true;
                        handData.pinchCooldown = 60;
                        // 根据当前阶段决定行为
                        // 水面阶段：捏合不跳过过渡，让用户完整体验涟漪→鱼影→上浮
                        // CRAFTING阶段: 捏合不触发阶段切换，形态推进交给仪式手势
                    }
                } else if (dist > 0.08) {
                    handData.isPinching = false;
                }
                handleFishingPinchFrame(dist < 0.04);
                
                // 冷却递减
                if (handData.pinchCooldown > 0) handData.pinchCooldown--;

            } else {
                handData.detected = false;
                // 清除水波纹手指数据
                if (waterRipple) {
                    waterRipple.setFingerPositions([]);
                }
            }
    }

    // 统一手势总线：单摄像头 + tasks-vision，驱动上面的 onHandResults
    startHandInput({ video, onResults: onHandResults, numHands: 2 })
        .then(() => {
            console.log('[INFO] 摄像头/手势启动成功 (tasks-vision)');
            document.getElementById('camera-canvas')?.classList.add('ready');
        })
        .catch((err) => {
            console.warn('[WARN] 摄像头/MediaPipe 不可用，仅键盘/鼠标交互可用:', err);
        });
}

// ═══════════════════════════════════════════════════════
// 麦克风 / 吹气检测
// ═══════════════════════════════════════════════════════
async function setupMicrophone() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(stream);
        micAnalyser = audioCtx.createAnalyser();
        micAnalyser.fftSize = 256;
        micAnalyser.smoothingTimeConstant = 0.5;
        source.connect(micAnalyser);
        micDataArray = new Uint8Array(micAnalyser.frequencyBinCount);
        console.log('[INFO] 麦克风启动成功，吹气检测已激活');
        
        // 显示麦克风图标
        const micIcon = document.getElementById('mic-indicator');
        if (micIcon) micIcon.style.display = 'block';
    } catch (e) {
        console.warn('[WARN] 麦克风不可用:', e.message);
    }
}

/**
 * 检测吹气：分析低频(0-2kHz)的能量是否持续高于阈值
 * 吹气特征：宽频噪声（不像说话有明显谐波）
 */
function detectBlow() {
    if (!micAnalyser || !micDataArray) return 0;
    micAnalyser.getByteFrequencyData(micDataArray);
    
    // 分析低频区域 (bin 0~20 ≈ 0~1.7kHz at 44100Hz, fftSize=256)
    let lowEnergy = 0;
    const lowBins = 20;
    for (let i = 1; i < lowBins; i++) {
        lowEnergy += micDataArray[i];
    }
    lowEnergy /= (lowBins - 1);
    
    // 分析中频区域 (bin 20~60)
    let midEnergy = 0;
    for (let i = 20; i < 60; i++) {
        midEnergy += micDataArray[i];
    }
    midEnergy /= 40;
    
    // 吹气判定：低频强（>80）且中频也有能量（宽频噪声特征）
    const isBlowing = lowEnergy > 80 && midEnergy > 40;
    
    if (isBlowing) {
        // 吹气强度与低频能量成正比
        return Math.min((lowEnergy - 80) / 100, 1.0);
    }
    return 0;
}

// ═══════════════════════════════════════════════════════
// PeerJS 手机连接
// ═══════════════════════════════════════════════════════
let peerConnection = null;

function setupPeerConnection() {
    if (typeof Peer === 'undefined' || typeof qrcode === 'undefined') {
        console.warn('[WARN] PeerJS 或 QRCode 库未加载，手机连接不可用');
        return;
    }

    const peer = new Peer();
    peer.on('open', (id) => {
        console.log('[INFO] PeerJS ID:', id);
        
        // 生成二维码 URL
        const host = location.hostname || 'localhost';
        const port = location.port || '8081';
        const phoneUrl = `http://${host}:${port}/phone.html?peer=${id}`;
        
        const qrCanvas = document.getElementById('qr-canvas');
        if (qrCanvas) {
            // qrcode-generator 库 API
            const qr = qrcode(0, 'M');
            qr.addData(phoneUrl);
            qr.make();
            
            const ctx = qrCanvas.getContext('2d');
            const size = 120;
            qrCanvas.width = size;
            qrCanvas.height = size;
            const modules = qr.getModuleCount();
            const cellSize = size / modules;
            
            ctx.fillStyle = '#0a1a30';
            ctx.fillRect(0, 0, size, size);
            ctx.fillStyle = '#e0d0a0';
            for (let row = 0; row < modules; row++) {
                for (let col = 0; col < modules; col++) {
                    if (qr.isDark(row, col)) {
                        ctx.fillRect(col * cellSize, row * cellSize, cellSize + 0.5, cellSize + 0.5);
                    }
                }
            }
            console.log('[INFO] QR码已生成:', phoneUrl);
        }
    });

    peer.on('connection', (conn) => {
        console.log('[INFO] 手机已连接');
        peerConnection = conn;
        const qrStatus = document.getElementById('qr-status');
        if (qrStatus) qrStatus.textContent = '✅ 手机已连接';
        
        conn.on('data', (data) => {
            handlePhoneData(data);
        });
        
        conn.on('close', () => {
            console.log('[INFO] 手机断开连接');
            peerConnection = null;
            if (qrStatus) qrStatus.textContent = '❌ 已断开';
        });
    });

    peer.on('error', (err) => {
        console.warn('[WARN] PeerJS错误:', err.type);
    });

    // QR 码显示/隐藏
    const qrToggle = document.getElementById('qr-toggle');
    const qrContainer = document.getElementById('qr-container');
    const qrClose = document.getElementById('qr-close');
    
    if (qrToggle && qrContainer) {
        qrToggle.addEventListener('click', () => {
            qrContainer.style.display = 'block';
            qrToggle.style.display = 'none';
        });
    }
    if (qrClose && qrContainer && qrToggle) {
        qrClose.addEventListener('click', () => {
            qrContainer.style.display = 'none';
            qrToggle.style.display = 'block';
        });
    }
}

/**
 * 处理手机端发送的数据
 */
function handlePhoneData(data) {
    if (!data || !data.type) return;
    
    switch (data.type) {
        case 'hand':
            // 手机触摸区域映射为 handData
            handData.detected = data.detected !== false;
            if (data.palmX !== undefined) handData.palmX = data.palmX;
            if (data.palmY !== undefined) handData.palmY = data.palmY;
            if (data.fingersUp !== undefined) handData.fingersUp = data.fingersUp;
            if (data.pinchDist !== undefined) handData.pinchDist = data.pinchDist;
            break;
            
        case 'gesture':
            // 按钮触发的离散手势
            if (data.gesture === 'pinch') {
                handData.isPinching = true;
                handData.pinchCooldown = 60;
                if (currentPhase === PHASES.FISHING) {
                    if (fishingPinchCount === 0) handleFirstFishingPinch();
                    else if (fishingPinchCount === 1) handleSecondFishingPinch();
                } else if (currentPhase === PHASES.LANTERN_SWARM) {
                    releaseUserLantern();
                }
                setTimeout(() => { handData.isPinching = false; }, 300);
            } else if (data.gesture === 'ritual-next') {
                if (currentPhase === PHASES.CRAFTING) {
                    if (currentStage === 0) enterCraftVideoExperience();
                    else if (currentStage < STAGES.length - 1) triggerRitualGesture(currentStage + 1);
                    else triggerRitualGesture('release');
                }
            }
            break;
            
        case 'blow':
            break;
    }
}

// ═══════════════════════════════════════════════════════
// UI 交互绑定
// ═══════════════════════════════════════════════════════
function toggleDevPanel(force) {
    const panel = document.getElementById('control-panel');
    if (!panel) return;
    const open = force === undefined ? !panel.classList.contains('dev-open') : force;
    panel.classList.toggle('dev-open', open);
}

function restartExperience() {
    cancelRevealAutoAdvance();
    if (particleSceneActive) deactivateParticleScene();
    if (craftVideoOpen) closeCraftVideoOverlay();
    catchShowcaseActive = false;
    hideFishKnowledgeCard();
    lanternSummonStage = 'idle';
    currentStage = 0;
    applyFishTextures(currentFishIndex, 0);
    enterPhase(PHASES.WATER);
    showToast('↺ 已重新开始', 1500);
}

function setupHud() {
    document.getElementById('hud-restart')?.addEventListener('click', restartExperience);
    document.getElementById('hud-switch-fish')?.addEventListener('click', () => {
        switchFishType((currentFishIndex + 1) % FISH_TYPES.length);
    });
    document.getElementById('hud-mute')?.addEventListener('click', (e) => {
        sfxMuted = !sfxMuted;
        const btn = e.currentTarget;
        btn.textContent = sfxMuted ? '🔇' : '🔊';
        btn.classList.toggle('muted', sfxMuted);
        btn.setAttribute('aria-pressed', String(sfxMuted));
    });
    document.getElementById('hud-dev')?.addEventListener('click', () => toggleDevPanel());
    document.getElementById('hud-back')?.addEventListener('click', goBack);

    // 鱼影显形粒子面板：5 种溶解特效 + 溶解滑块
    document.querySelectorAll('#reveal-panel .rp-fx button').forEach((b) => {
        b.addEventListener('click', () => {
            revealFxMode = parseInt(b.dataset.fx) || 0;
            if (particleScene) particleScene.setFxMode(revealFxMode);
            syncRevealPanel();
            revealIdle = 0; // 视为交互，刷新无人值守计时
        });
    });
    document.getElementById('rp-dissolve')?.addEventListener('input', (e) => {
        if (particleScene) particleScene.setDissolveManual(parseFloat(e.target.value));
        revealIdle = 0;
    });
}

// 返回上一步：处理制灯视频/鱼影显形/灯阶段的逆向跳转
function goBack() {
    if (craftVideoOpen) {            // 科普(制灯视频) → 鱼影显形
        returnToReveal();
        return;
    }
    if (catchShowcaseActive) {       // 鱼影显形 → 重新钓鱼
        cancelRevealAutoAdvance();
        if (particleSceneActive) deactivateParticleScene();
        enterPhase(PHASES.FISHING);
        return;
    }
    switch (currentPhase) {
        case PHASES.LANTERN_SWARM: enterPhase(PHASES.LANTERN_RECEIVE); break;
        case PHASES.LANTERN_RECEIVE:                 // 鱼灯领取 → 回到制灯视频
            clearLanternDanceTimers();
            lanternSummonStage = 'idle';             // 否则 enterCraftVideoExperience 会被守卫拦下
            setLanternNightMode(false);
            currentPhase = PHASES.CRAFTING;
            enterCraftVideoExperience(true);
            break;
        case PHASES.CRAFTING: returnToReveal(); break;
        case PHASES.FISHING: enterPhase(PHASES.WATER); break;
        default: showToast('已是第一步', 1200);
    }
}

// 回到「鱼影显形」环节（保留已钓起的鱼）
function returnToReveal() {
    cancelCraftVideoFallback();
    closeCraftVideoOverlay();
    clearLanternDanceTimers();
    lanternSummonStage = 'idle';
    setLanternNightMode(false);
    document.getElementById('gesture-progress')?.style.setProperty('display', 'none');
    currentPhase = PHASES.FISHING;
    fishingState = FISH_STATE.CAUGHT;
    catchShowcaseActive = false;
    if (fishMeshGroup) {
        startCatchShowcase();
    } else {
        enterPhase(PHASES.FISHING);
    }
    updatePhaseIndicator();
}

function setupUI() {
    setupHud();
    // 开发面板关闭按钮（✕）
    document.getElementById('panel-toggle').addEventListener('click', () => {
        toggleDevPanel(false);
    });

    document.getElementById('ritual-dismiss')?.addEventListener('click', () => {
        document.getElementById('ritual-cue')?.classList.add('is-hidden');
    });
    document.getElementById('craft-video-close')?.addEventListener('click', finishCraftVideoAndRevealLantern);
    document.getElementById('craft-video-back')?.addEventListener('click', returnToReveal);
    document.getElementById('fkc-enter-craft')?.addEventListener('click', beginCraftFromCatch);
    document.getElementById('lantern-summon-btn')?.addEventListener('click', () => {
        if (lanternSummonStage === 'danceReleaseReady') releaseUserLantern();
        else if (lanternSummonStage === 'particles') completeLanternParticleReceive();
        else if (lanternSummonStage === 'model') enterLanternDance();
        else handleSummonLantern();
    });

    // 水面阶段：单击触发涟漪（无需摄像头）
    let clickStart = null;
    renderer.domElement.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || currentPhase !== PHASES.WATER) return;
        clickStart = { x: e.clientX, y: e.clientY };
    });
    renderer.domElement.addEventListener('mousemove', (e) => {
        if (!clickStart || currentPhase !== PHASES.WATER) return;
        const rect = renderer.domElement.getBoundingClientRect();
        updateWakePalmWave(
            (e.clientX - rect.left) / rect.width,
            (e.clientY - rect.top) / rect.height,
            true
        );
    });
    let lastClickRipple = 0;
    renderer.domElement.addEventListener('mouseup', (e) => {
        if (e.button !== 0 || !clickStart || currentPhase !== PHASES.WATER || !waterRipple) return;
        const moved = Math.hypot(e.clientX - clickStart.x, e.clientY - clickStart.y);
        clickStart = null;
        if (moved > 8) return;
        const now = performance.now();
        if (now - lastClickRipple < 600) return;
        lastClickRipple = now;
        const rect = renderer.domElement.getBoundingClientRect();
        waterRipple.addRippleAt(
            (e.clientX - rect.left) / rect.width,
            1 - (e.clientY - rect.top) / rect.height
        );
        fishAttractionTimer += 0.4;
    });

    // 滑块绑定
    document.getElementById('ctrl-size').addEventListener('input', e => {
        uniforms.uSize.value = parseFloat(e.target.value);
    });
    document.getElementById('ctrl-fluid')?.addEventListener('input', e => {
        uniforms.uFluidStrength.value = parseFloat(e.target.value);
    });
    document.getElementById('ctrl-breath').addEventListener('input', e => {
        uniforms.uBreathAmp.value = parseFloat(e.target.value);
    });
    document.getElementById('ctrl-threshold').addEventListener('input', e => {
        uniforms.uThreshold.value = parseFloat(e.target.value);
    });

    // 颜色按钮
    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const color = btn.getAttribute('data-color');
            if (color === 'none') {
                uniforms.uTintStrength.value = 0;
            } else {
                const c = new THREE.Color(color);
                uniforms.uTintColor.value.set(c.r, c.g, c.b);
                uniforms.uTintStrength.value = 1.0;
            }
        });
    });

    // 自定义颜色
    document.getElementById('custom-color').addEventListener('input', e => {
        document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
        const c = new THREE.Color(e.target.value);
        uniforms.uTintColor.value.set(c.r, c.g, c.b);
        uniforms.uTintStrength.value = 1.0;
    });

    // 水面色调按钮
    document.querySelectorAll('.water-color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.water-color-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const theme = btn.getAttribute('data-water');
            if (waterRipple) waterRipple.setColorTheme(theme);
        });
    });

    // 场景阶段按钮
    document.querySelectorAll('.stage-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const phase = btn.getAttribute('data-phase');
            if (phase) enterPhase(phase);
        });
    });

    const stageDotPhases = [PHASES.WATER, PHASES.FISHING, PHASES.CRAFTING, PHASES.LANTERN_RECEIVE, PHASES.LANTERN_SWARM];
    document.querySelectorAll('#stage-indicator .dot').forEach((dot) => {
        const idx = Number(dot.dataset.idx);
        if (idx === 2) dot.textContent = '🛠️';
        dot.setAttribute('role', 'button');
        dot.setAttribute('tabindex', '0');
        const jump = () => {
            const phase = stageDotPhases[idx];
            if (phase) enterPhase(phase);
        };
        dot.addEventListener('click', jump);
        dot.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                jump();
            }
        });
    });

    // 手势超时设置
    for (let i = 0; i < 5; i++) {
        const slider = document.getElementById(`ctrl-timeout-${i}`);
        const label = document.getElementById(`timeout-val-${i}`);
        if (!slider || !label) continue;
        slider.value = String(RITUAL_TIMEOUTS[i]);
        label.textContent = `${RITUAL_TIMEOUTS[i]}s`;
        slider.addEventListener('input', (e) => {
            const value = Math.max(0, parseInt(e.target.value, 10) || 0);
            RITUAL_TIMEOUTS[i] = value;
            label.textContent = `${value}s`;
            resetRitualTimeout();
        });
    }

    const resetBtn = document.getElementById('reset-defaults');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            resetTimeoutDefaults();
        });
    }
}

function resetTimeoutDefaults() {
    RITUAL_TIMEOUTS = [...DEFAULTS.ritualTimeouts];
    for (let i = 0; i < 5; i++) {
        const slider = document.getElementById(`ctrl-timeout-${i}`);
        const label = document.getElementById(`timeout-val-${i}`);
        if (!slider || !label) continue;
        slider.value = String(RITUAL_TIMEOUTS[i]);
        label.textContent = `${RITUAL_TIMEOUTS[i]}s`;
    }
    resetRitualTimeout();
}

function updateUI() {
    // 场景阶段按钮高亮
    document.querySelectorAll('.stage-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-phase') === currentPhase);
    });
    updatePhaseIndicator();
}

// ═══════════════════════════════════════════════════════
// Toast 提示
// ═══════════════════════════════════════════════════════
function showToast(msg, duration = 2000) {
    let toast = document.getElementById('fish-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'fish-toast';
        toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);padding:10px 24px;background:rgba(0,0,0,0.8);color:#fff;border-radius:8px;font-size:16px;z-index:9999;opacity:0;transition:opacity 0.3s;pointer-events:none;';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, duration);
}

// ═══════════════════════════════════════════════════════
// 键盘事件
// ═══════════════════════════════════════════════════════
function onKeyDown(e) {
    if (e.code === 'KeyR') releaseUserLantern();
    if (e.code === 'KeyD') toggleDevPanel();           // 开发面板开关
    // 调试：手动切换粒子场景（不改变阶段），便于对比鱼影显形效果
    if (e.code === 'KeyG') {
        if (particleSceneActive) deactivateParticleScene();
        else activateParticleScene();
    }
    if (e.code === 'KeyP' && currentPhase === PHASES.FISHING) {
        if (fishingPinchCount === 0) handleFirstFishingPinch();
        else if (fishingPinchCount === 1) handleSecondFishingPinch();
    }
    if (e.code === 'Space') {
        e.preventDefault();
        if (currentPhase === PHASES.WATER) {
            advancePhase(); // 进入钓鱼
        } else if (currentPhase === PHASES.FISHING) {
            if (catchShowcaseActive) {
                beginCraftFromCatch();
            } else if (fishingState < FISH_STATE.CAUGHT) {
                showToast('🎣 请等待完整钓鱼过程…', 1400);
            }
        } else if (currentPhase === PHASES.CRAFTING) {
            if (craftVideoOpen) {
                finishCraftVideoAndRevealLantern();
            } else if (currentStage === 0) {
                enterCraftVideoExperience();
            } else if (currentStage < STAGES.length - 1) {
                triggerRitualGesture(currentStage + 1); // 调试兜底：按顺序模拟仪式完成
            } else {
                triggerRitualGesture('release');
            }
        } else if (currentPhase === PHASES.LANTERN_SWARM) {
            advancePhase(); // 回到水面
        }
    }
    // 数字键1-4切换阶段（调试用）
    if (!e.shiftKey) {
        if (e.code === 'Digit1') enterPhase(PHASES.WATER);
        if (e.code === 'Digit2') enterPhase(PHASES.FISHING);
        if (e.code === 'Digit3') enterPhase(PHASES.CRAFTING);
        if (e.code === 'Digit4') enterPhase(PHASES.LANTERN_RECEIVE);
        if (e.code === 'Digit5') enterPhase(PHASES.LANTERN_SWARM);
    }

    // Shift+1-5 切换鱼种（隐藏快捷键）
    if (e.shiftKey) {
        if (e.code === 'Digit1') switchFishType(0);
        if (e.code === 'Digit2') switchFishType(1);
        if (e.code === 'Digit3') switchFishType(2);
        if (e.code === 'Digit4') switchFishType(3);
        if (e.code === 'Digit5') switchFishType(4);
    }

    // 左右方括号也可切换鱼种
    if (e.code === 'BracketLeft')  switchFishType(currentFishIndex - 1);
    if (e.code === 'BracketRight') switchFishType(currentFishIndex + 1);

    if (e.code === 'Escape' && craftVideoOpen) {
        finishCraftVideoAndRevealLantern();
    }
}

// ═══════════════════════════════════════════════════════
// 窗口大小调整
// ═══════════════════════════════════════════════════════
function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (waterRipple) waterRipple.resize(window.innerWidth, window.innerHeight);
}

// ═══════════════════════════════════════════════════════
// 钓鱼线 + 鱼钩 (2D线条)
// ═══════════════════════════════════════════════════════
function createFishingLine() {
    if (fishingLine) { scene.remove(fishingLine); fishingLine = null; }
    const group = new THREE.Group();
    
    // 鱼线：从画面顶部垂下的曲线
    const lineMat = new THREE.LineBasicMaterial({ color: 0xcccccc, linewidth: 1.5, transparent: true, opacity: 0.7 });
    const lineGeo = new THREE.BufferGeometry();
    // 初始点位，后续 animate 中动态更新
    const pts = [];
    for (let i = 0; i <= 20; i++) {
        pts.push(0, 0, 0);
    }
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const line = new THREE.Line(lineGeo, lineMat);
    line.name = 'fishing-line';
    group.add(line);
    
    // 鱼钩：简单的弯钩形状
    const hookMat = new THREE.LineBasicMaterial({ color: 0x888888, linewidth: 2 });
    const hookShape = new THREE.BufferGeometry();
    const hookPts = [
        0, 0, 0,       // 连接点
        0, -3, 0,      // 直杆
        1, -5, 0,      // 弯曲开始
        2, -4.5, 0,    // 钩尖
        1.5, -3.5, 0,  // 倒刺
    ];
    hookShape.setAttribute('position', new THREE.Float32BufferAttribute(hookPts, 3));
    const hook = new THREE.Line(hookShape, hookMat);
    hook.name = 'fishing-hook';
    group.add(hook);
    
    group.visible = true;
    scene.add(group);
    fishingLine = group;
}

function updateFishingLine(time) {
    if (!fishingLine) return;
    const line = fishingLine.getObjectByName('fishing-line');
    const hook = fishingLine.getObjectByName('fishing-hook');
    if (!line) return;
    
    // 鱼线从画面上方（竿的位置）垂下到鱼钩位置
    const rodX = 15;  // 竿在右上方
    const rodY = 65;  // 画面顶部
    
    // 鱼钩终点：正常摆动 or 跟随鱼嘴位置（咬钩后）
    let hookX, hookY;
    if (fishingState >= FISH_STATE.BITING && fishDartCtrl) {
        // 咬钩后鱼线连接鱼嘴（鼻子方向偏移）
        const dir = fishDartCtrl.direction;
        const mouthOffset = 12;
        hookX = fishDartCtrl.pos.x + dir.x * mouthOffset;
        hookY = fishDartCtrl.pos.y + dir.y * mouthOffset;
    } else {
        hookX = rodX + Math.sin(time * 0.8) * 5;
        hookY = -10 + Math.sin(time * 0.5) * 3;
    }
    
    // 挣扎时线的抖动；咬钩后也有张力
    const tensionBase = fishingState === FISH_STATE.STRUGGLING ? 1.2 : (fishingState === FISH_STATE.BITING ? 0.6 : 0);
    const tension = tensionBase + Math.sin(time * (fishingState === FISH_STATE.STRUGGLING ? 10 : 7)) * tensionBase * 0.4;
    
    // 用二次贝塞尔曲线生成鱼线点
    const positions = line.geometry.attributes.position.array;
    const segments = 20;
    const ctrlX = (rodX + hookX) * 0.5 + tension;
    const ctrlY = (rodY + hookY) * 0.5 + 10;
    
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const x = (1-t)*(1-t)*rodX + 2*(1-t)*t*ctrlX + t*t*hookX;
        const y = (1-t)*(1-t)*rodY + 2*(1-t)*t*ctrlY + t*t*hookY;
        positions[i*3] = x;
        positions[i*3+1] = y;
        positions[i*3+2] = 1;
    }
    line.geometry.attributes.position.needsUpdate = true;
    
    // 更新鱼钩位置
    if (hook) {
        hook.position.set(hookX, hookY, 1);
        // 咬钩后隐藏独立鱼钩（鱼嘴含着）
        hook.visible = fishingState < FISH_STATE.BITING;
    }
}

// ═══════════════════════════════════════════════════════
// 动画循环
// ═══════════════════════════════════════════════════════
function animate() {
    requestAnimationFrame(animate);

    const dt = clock.getDelta();
    const time = clock.getElapsedTime();

    if (catchShowcaseActive && !particleSceneActive) {
        revealIdle += dt;
        if (revealIdle >= REVEAL_IDLE_AUTO_S) { beginCraftFromCatch(); return; }
        if (knowledgePreview?.mesh) {
            knowledgePreview.yaw += 0.26 * dt;
            knowledgePreview.mesh.rotation.set(0, knowledgePreview.yaw, 0);
            knowledgePreview.renderer.render(knowledgePreview.scene, knowledgePreview.camera);
        }
    }

    // 粒子「鱼影显形」场景叠加在最上层（自带渲染），主场景照常更新（知识卡片预览等需保持运行）
    if (particleSceneActive && particleScene) {
        particleScene.update(dt, sharedHandData);
        // 实时同步溶解滑块到粒子场景当前值（让滑块跟手势联动而不只是单向控制）
        const rpSlider = document.getElementById('rp-dissolve');
        if (rpSlider) rpSlider.value = String(particleScene.dissolveValue.toFixed(3));
        // 推进只靠：点「开始制灯」按钮 / 无人值守长时间空闲。有手在交互时绝不自动跳。
        if (catchShowcaseActive) {
            revealIdle += dt;
            if (revealIdle >= REVEAL_IDLE_AUTO_S) { beginCraftFromCatch(); return; }
            // 鱼影显形：只渲染粒子场景 + 知识卡片小预览，跳过昂贵的主场景（水面FBO/鱼群）防卡顿
            if (knowledgePreview?.mesh) {
                knowledgePreview.yaw += 0.26 * dt;
                knowledgePreview.mesh.rotation.set(0, knowledgePreview.yaw, 0);
                knowledgePreview.renderer.render(knowledgePreview.scene, knowledgePreview.camera);
            }
            return;
        }
    }

    // 更新 uniforms
    uniforms.uTime.value = time;

    // RELEASE 阶段：更新鱼群 boids
    if (false && fishSchool) {
        const handPos = handData.detected
            ? new THREE.Vector2(-handData.palmX * 100, -handData.palmY * 70)
            : null;
        fishSchool.update(dt, time, handPos);
        // 鱼群气泡：随机从某条鱼尾部冒泡
        if (bubbleSystem && Math.random() < 0.08) {
            const randomFish = fishSchool.fishes[Math.floor(Math.random() * fishSchool.fishes.length)];
            if (randomFish) {
                const dir = randomFish.direction;
                const tailX = randomFish.pos.x - dir.x * 10;
                const tailY = randomFish.pos.y - dir.y * 10;
                bubbleSystem.emit(tailX, tailY, 1, { sizeMin: 1.0, sizeMax: 2.5, speedUp: 10, spread: 2 });
            }
        }
    }

    // 钓获展示 / 制灯：绕 Y 轴横向 360° 旋转
    const showcaseRotate = !lanternRevealActive && !isMorphing
        && ((currentPhase === PHASES.CRAFTING && fishMeshGroup?.visible)
        || (currentPhase === PHASES.FISHING && catchShowcaseActive && fishMeshGroup));
    if (showcaseRotate) {
        craftFishYaw += 0.26 * dt;
        fishMeshGroup.quaternion.identity();
        fishMeshGroup.rotation.set(0, craftFishYaw, 0);
        if (catchShowcaseActive) {
            fishMeshGroup.position.set(CATCH_FISH_OFFSET.x, CATCH_FISH_OFFSET.y, CATCH_FISH_OFFSET.z);
        } else {
            fishMeshGroup.position.set(0, 0, 0);
        }
        if (fishSwimCtrl) {
            fishSwimCtrl.uniforms.uSwimTime.value = time;
            fishSwimCtrl.uniforms.uSwimSpeed.value = 2.0;
            fishSwimCtrl.uniforms.uSwimAmp.value = 0.1;
        }
    }

    if (catchShowcaseActive && knowledgePreview?.mesh) {
        knowledgePreview.yaw += 0.26 * dt;
        knowledgePreview.mesh.rotation.set(0, knowledgePreview.yaw, 0);
        knowledgePreview.renderer.render(knowledgePreview.scene, knowledgePreview.camera);
    }

    // 鱼灯点亮仪式动画
    if (lanternGlowing && lanternMeshGroup && lanternMeshGroup.visible) {
        lanternGlowProgress = Math.min(1.0, lanternGlowProgress + dt * 0.4); // 约2.5秒完全点亮
        const glow = lanternGlowProgress * lanternGlowProgress; // ease-in
        // 鱼灯材质发光
        lanternMeshGroup.traverse((obj) => {
            if (obj.isMesh && obj.material && obj.material.emissive) {
                obj.material.emissiveIntensity = glow * 0.8;
                // 暖色调发光
                obj.material.emissive.setRGB(1.0, 0.6, 0.2);
            }
        });
        // 内部点光源
        if (lanternPointLight) {
            lanternPointLight.intensity = glow * 3.0;
            // 呼吸闪烁
            const flicker = 1.0 + Math.sin(time * 4) * 0.1 + Math.sin(time * 7) * 0.05;
            lanternPointLight.intensity *= flicker;
        }
        if (lanternGlowProgress >= 1.0) lanternGlowing = false;
    }

    if (lanternMeshGroup?.visible && lanternModelFadeProgress < 1) {
        lanternModelFadeProgress = Math.min(1, lanternModelFadeProgress + dt * 1.6);
        lanternMeshGroup.traverse((obj) => {
            if (!obj.isMesh || !obj.material) return;
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach((mat) => { mat.opacity = lanternModelFadeProgress; });
        });
    }

    // 更新物理水波纹
    updateLanternDanceAnimation(dt, time);

    if (waterRipple && !document.body.classList.contains('lantern-night-stage')) {
        waterRipple.update(time);
        if (rippleMesh) {
            rippleMesh.material.map = waterRipple.getOutputTexture();
            rippleMesh.material.needsUpdate = true;
        }
    }

    // 阶段特殊动画
    if (currentPhase === PHASES.WATER) {
        const hintEl = document.getElementById('hint-text');
        ambientRippleTimer += dt;
        if (ambientRippleTimer > 8.0 && waterRipple) {
            ambientRippleTimer = 0;
            waterRipple.emitAmbientRipple();
        }
        if (!wakeFishActive) {
            hideAllFishMeshes();
            if (hintEl) hintEl.textContent = '张开手掌左右轻摆，唤醒水中的鱼影';
            // 无人值守：水面静置 25 秒后自动开始（有人挥手会立即开始）
            waterIdleElapsed += dt;
            if (waterIdleElapsed > 25) startWakeFishStage();
        } else {
            wakeFishElapsed = Math.min(WAKE_FISH_DURATION, wakeFishElapsed + dt);
            fishAttractionTimer = wakeFishElapsed;
            const wakeProgress = wakeFishElapsed / WAKE_FISH_DURATION;
            updateWakeFishShadows(wakeProgress, time);
            if (hintEl) hintEl.textContent = `鱼影逐渐清晰 · ${Math.ceil(WAKE_FISH_DURATION - wakeFishElapsed)} 秒`;
            if (wakeFishElapsed >= WAKE_FISH_DURATION && !phaseTransitioning) {
                enterPhase(PHASES.FISHING);
            }
        }
    }

    if (currentPhase === PHASES.FISHING && fishingState < FISH_STATE.CAUGHT && !catchShowcaseActive) {
        updateBackgroundFish(dt, time);
    }
    
    if (currentPhase === PHASES.FISHING && fishMeshGroup && fishDartCtrl && !catchShowcaseActive) {
        // 钓鱼阶段状态机
        fishMeshSwimTime += dt;
        fishingStateTimer += dt;
        const fadeIn = Math.min(fishMeshSwimTime * 0.5, 1.0);

        // 鱼钩位置（与 updateFishingLine 保持同步）
        const hookX = 15 + Math.sin(time * 0.8) * 5;
        const hookY = -10 + Math.sin(time * 0.5) * 3;

        switch (fishingState) {
            case FISH_STATE.SWIMMING:
                // 自由游动；第一次捏合仅放线，第二次捏合才会上钩
                fishDartCtrl.update(dt);
                break;

            case FISH_STATE.APPROACHING:
                fishDartCtrl.attractTo(hookX, hookY);
                const distToHook = Math.hypot(fishDartCtrl.pos.x - hookX, fishDartCtrl.pos.y - hookY);
                fishDartCtrl.targetSpeed = Math.min(85, 28 + distToHook * 0.9);
                fishDartCtrl.update(dt);
                if (distToHook < 25 || (fishingStateTimer > 14 && distToHook < 45)) {
                    fishingState = FISH_STATE.BITING;
                    fishingStateTimer = 0;
                    setFishingBodyFx('tension');
                    if (splashSystem) splashSystem.burst(fishDartCtrl.pos.x, fishDartCtrl.pos.y, { count: 30, power: 70, color: [0.6, 0.9, 1.0] });
                    document.body.style.animation = 'screenShake 0.35s ease-out';
                    setTimeout(() => { document.body.style.animation = ''; }, 350);
                    const hintEl = document.getElementById('hint-text');
                    if (hintEl) hintEl.textContent = '🎣 鱼咬钩了！';
                    showToast('🎣 鱼咬钩了！', 1500);
                } else if (fishingStateTimer > 20) {
                    fishDartCtrl.pos.set(hookX - 8, hookY, fishDartCtrl.pos.z);
                    fishingState = FISH_STATE.BITING;
                    fishingStateTimer = 0;
                    setFishingBodyFx('tension');
                }
                break;

            case FISH_STATE.BITING:
                fishDartCtrl.pos.x += (hookX - fishDartCtrl.pos.x) * dt * 6;
                fishDartCtrl.pos.y += (hookY - fishDartCtrl.pos.y) * dt * 6;
                fishDartCtrl.heading = Math.sin(time * 10) * 0.12;
                if (fishingStateTimer > 1.0) {
                    fishingState = FISH_STATE.STRUGGLING;
                    fishingStateTimer = 0;
                    fishingStruggleCount = 0;
                    fishingReelAssist = 0;
                    setFishingBodyFx('struggle');
                    const hintEl = document.getElementById('hint-text');
                    if (hintEl) hintEl.textContent = '💪 鱼在挣扎，稳住鱼竿…';
                    showToast('💪 鱼在挣扎…', 1500);
                }
                break;

            case FISH_STATE.STRUGGLING: {
                const struggleProgress = fishingStateTimer / 5.5;
                const struggleAmp = (7 + fishingStruggleCount * 0.05) * Math.max(0.5, 1 - struggleProgress * 0.6);
                const struggleFreq = 5 + fishingStruggleCount * 0.04;
                const pullY = Math.sin(time * struggleFreq * 0.6) * 2.5;
                fishDartCtrl.pos.x = hookX + Math.sin(time * struggleFreq) * struggleAmp;
                fishDartCtrl.pos.y = hookY - 4 + pullY + Math.sin(time * struggleFreq * 1.2) * (struggleAmp * 0.35);
                fishDartCtrl.heading = Math.sin(time * struggleFreq) * 0.3;
                fishingStruggleCount++;
                fishingReelAssist = Math.max(0, fishingReelAssist - dt * 0.2);
                const catchAfter = 5.5 - fishingReelAssist * 1.2;
                if (fishingStateTimer > catchAfter) {
                    fishingState = FISH_STATE.CAUGHT;
                    fishingStateTimer = 0;
                    setFishingBodyFx(null);
                    hideNonTargetFish();
                    resetSingleFishMaterial(fishMeshGroup);
                    if (splashSystem) splashSystem.burst(fishDartCtrl.pos.x, fishDartCtrl.pos.y, { count: 40, power: 100, color: [0.7, 0.95, 1.0] });
                    const hintEl = document.getElementById('hint-text');
                    if (hintEl) hintEl.textContent = '🏆 成功钓到了！';
                    const kInfo = FISH_KNOWLEDGE[currentFishIndex];
                    showToast(`🏆 钓到了 ${kInfo?.shadowName || FISH_TYPES[currentFishIndex].name}！`, 2500);
                    document.body.style.transform = '';
                    startCatchShowcase();
                }
                break;
            }

            case FISH_STATE.CAUGHT:
                if (!catchShowcaseActive) {
                    fishDartCtrl.pos.y += 45 * dt;
                    fishDartCtrl.heading = Math.PI / 2;
                }
                break;
        }

        // 非SWIMMING/APPROACHING状态下手动改了heading，需同步3D朝向
        if (fishingState >= FISH_STATE.BITING) {
            const pitchVal = fishingState === FISH_STATE.CAUGHT ? 0.3 : 0;
            // 方向强制XY平面（纯侧影）
            fishDartCtrl.direction.set(
                Math.cos(fishDartCtrl.heading),
                Math.sin(fishDartCtrl.heading) * 0.4 + pitchVal,
                0
            ).normalize();
            // matrix-based quaternion（鱼背朝上）
            const _right = new THREE.Vector3();
            const _corrUp = new THREE.Vector3();
            const _mat = new THREE.Matrix4();
            const _wUp = new THREE.Vector3(0, 1, 0);
            _right.crossVectors(_wUp, fishDartCtrl.direction);
            if (_right.lengthSq() < 0.001) _right.set(0, 0, -1);
            _right.normalize();
            _corrUp.crossVectors(fishDartCtrl.direction, _right).normalize();
            _mat.makeBasis(_right, _corrUp, fishDartCtrl.direction);
            fishDartCtrl.quaternion.setFromRotationMatrix(_mat);
        }

        // 应用位置（3D）
        fishMeshGroup.position.x = fishDartCtrl.pos.x;
        fishMeshGroup.position.y = fishDartCtrl.pos.y;
        fishMeshGroup.position.z = fishDartCtrl.pos.z;

        // 身体摇摆（S-wave尾部振动）：振幅与速度联动，挣扎时更剧烈
        const speedRatio = fishDartCtrl.speed / 150;
        const wiggleBase = fishingState === FISH_STATE.STRUGGLING ? 0.12 : (0.04 + speedRatio * 0.08);
        const wiggleFreq = 3.0 + speedRatio * 2.5;
        const swimWiggle = Math.sin(time * wiggleFreq) * wiggleBase;
        
        // 3D朝向：使用四元数，鱼鼻子对准速度方向
        fishMeshGroup.quaternion.copy(fishDartCtrl.quaternion);
        // 叠加局部Y轴摆尾
        fishMeshGroup.rotateY(swimWiggle);

        // 更新顶点着色器时间（如果注入成功）
        if (fishSwimCtrl) {
            fishSwimCtrl.uniforms.uSwimTime.value = time;
            fishSwimCtrl.uniforms.uSwimSpeed.value = 2.0 + speedRatio * 3.0;
            fishSwimCtrl.uniforms.uSwimAmp.value = 0.12 + speedRatio * 0.15;
        }

        // 鱼鳞微光：转弯时鳞片反光闪烁
        const bank = fishDartCtrl.bankAngle || 0;
        const shimmerStrength = Math.abs(bank) * 2.0 + speedRatio * 0.3;
        const sparkle = Math.max(0, Math.sin(time * 8 + Math.sin(time * 3) * 2)) * shimmerStrength;
        fishMeshGroup.traverse((obj) => {
            if (obj.isMesh && obj.material && obj.material.emissive) {
                obj.material.emissiveIntensity = 0.05 + sparkle * 0.4;
            }
        });

        // 渐入透明度
        if (fadeIn < 1.0) {
            fishMeshGroup.traverse((obj) => {
                if (obj.isMesh && obj.material) {
                    obj.material.transparent = true;
                    obj.material.opacity = fadeIn;
                }
            });
        }
        
        // 更新钓鱼线动画
        updateFishingLine(time);

        // 气泡：从鱼尾部定期释放
        if (bubbleSystem && Math.random() < 0.15) {
            const tailOffset = 15;
            const dir = fishDartCtrl.direction;
            const tailX = fishDartCtrl.pos.x - dir.x * tailOffset;
            const tailY = fishDartCtrl.pos.y - dir.y * tailOffset;
            bubbleSystem.emit(tailX, tailY, 1, { sizeMin: 1.0, sizeMax: 3.0, speedUp: 12, spread: 3 });
        }
        // 水花：挣扎时持续溅水
        if (splashSystem && (fishingState === FISH_STATE.STRUGGLING || fishingState === FISH_STATE.BITING) && Math.random() < 0.18) {
            splashSystem.burst(fishDartCtrl.pos.x, fishDartCtrl.pos.y, { count: fishingState === FISH_STATE.STRUGGLING ? 2 : 1, power: 30 });
        }
    }

    // 钓鱼阶段镜头：仅轻微晃动，避免惊吓
    if (currentPhase === PHASES.FISHING && fishingState === FISH_STATE.STRUGGLING) {
        const intensity = 0.35 + Math.sin(fishingStateTimer * 2.5) * 0.15;
        camera.position.set(
            Math.sin(time * 14) * intensity,
            Math.cos(time * 12) * intensity * 0.35,
            FISHING_CAM_Z
        );
    } else if (currentPhase === PHASES.FISHING) {
        if (catchShowcaseActive) {
            camera.position.set(-12, 2, FISHING_CAM_Z);
        } else {
            camera.position.set(0, 0, FISHING_CAM_Z);
        }
    }

    // 状态超时保护：超时自动切换
    if (!phaseTransitioning) {
        if (
            currentPhase === PHASES.CRAFTING &&
            lanternSummonStage === 'idle' &&
            !isBoidsMode &&
            !craftVideoOpen
        ) {
            ritualTimeoutTimer += dt;
            const limit = RITUAL_TIMEOUTS[currentStage] ?? 0;
            if (limit > 0 && ritualTimeoutTimer >= limit) {
                ritualTimeoutTimer = 0;
                if (currentStage === 0) {
                    enterCraftVideoExperience();
                } else if (currentStage < STAGES.length - 1) {
                    triggerRitualGesture(currentStage + 1);
                } else {
                    triggerRitualGesture('release');
                }
            }
        } else if (currentPhase === PHASES.LANTERN_SWARM) {
            // 鱼灯游群阶段保持夜景巡游，等待用户放飞专属鱼灯
        }
    }

    // 形态变形进度
    if (isMorphing) {
        const morphDur = lanternRevealActive ? 2.6 : CONFIG.morphDuration;
        morphProgress += dt / morphDur;
        if (morphProgress >= 1.0) {
            morphProgress = 1.0;
            isMorphing = false;
            // morph 结束后，A 变成 B
            uniforms.uPosA.value = uniforms.uPosB.value;
            uniforms.uColA.value = uniforms.uColB.value;
            uniforms.uMorph.value = 0.0;
            // 移除背景暗化
            morphOverlay.style.opacity = '0';
            if (lanternRevealActive && lanternMeshGroup) {
                lanternSummonStage = 'outlineHold';
                updateLanternSummonCopy('鱼灯轮廓已现', 'THE LANTERN OUTLINE EMERGES');
                if (particleSystem) particleSystem.visible = true;
                lanternOutlineHoldTimer = setTimeout(completeLanternRevealModel, 5000);
            } else if (currentStage === 1 && lanternMeshGroup) {
                if (particleSystem) particleSystem.visible = false;
                showLanternModel();
            } else if (currentStage === 0 && fishMeshGroup) {
                if (particleSystem) particleSystem.visible = false;
                fishMeshGroup.visible = true;
            }
        } else {
            // 使用 ease-in-out
            const t = morphProgress;
            uniforms.uMorph.value = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        }
    }

    // 手势控制（仅在制灯阶段有效）
    if (!isBoidsMode && currentPhase === PHASES.CRAFTING) {
        const ritualOnlyVisuals = true;

        if (ritualOnlyVisuals) {
            // 仅允许仪式手势推进，不让其他手势影响画面
            if (particleSystem) {
                particleSystem.position.x *= 0.95;
                particleSystem.position.y *= 0.95;
            }
            openPalmHoldTime = 0;
            scatterStrength = Math.max(scatterStrength - dt * 2.0, 0.0);
            uniforms.uScatter.value = scatterStrength;
            controls.autoRotate = true;
        } else if (handData.detected) {
            // 粒子跟随手掌位置
            if (particleSystem) {
                // 握拳时强力吸引，其他手型柔和跟随
                const isFist = handData.fingersUp <= 1;
                const range = isFist ? 60 : 40;
                const rangeY = isFist ? 50 : 30;
                const lerpSpeed = isFist ? 0.10 : 0.04;
                const targetX = -handData.palmX * range;
                const targetY = -handData.palmY * rangeY;
                particleSystem.position.x += (targetX - particleSystem.position.x) * lerpSpeed;
                particleSystem.position.y += (targetY - particleSystem.position.y) * lerpSpeed;
            }

            // 仪式手势阶段禁用“张手散开”，避免与固定手势冲突
            const allowOpenPalmScatter = false;
            if (allowOpenPalmScatter && handData.fingersUp >= 4) {
                openPalmHoldTime += dt;
                if (openPalmHoldTime > 0.5) {
                    scatterStrength = Math.min(scatterStrength + dt * 2.0, 1.0);
                }
            } else {
                openPalmHoldTime = 0;
                scatterStrength = Math.max(scatterStrength - dt * 2.0, 0.0);
            }
            // 更新散开 uniform 和手掌世界坐标
            uniforms.uScatter.value = scatterStrength;
            uniforms.uHandWorld.value.set(-handData.palmX * 120, -handData.palmY * 120, 0);

            // 禁用轨道自动旋转（手势优先）
            controls.autoRotate = false;
        } else {
            // 无手势时归位并恢复自动旋转
            if (particleSystem) {
                particleSystem.position.x *= 0.95;
                particleSystem.position.y *= 0.95;
            }
            scatterStrength = Math.max(scatterStrength - dt * 2.0, 0.0);
            uniforms.uScatter.value = scatterStrength;
            controls.autoRotate = true;
        }
    }

    // 鱼群模式更新
    if (isBoidsMode) {
        const ritualOnlyVisuals = true;
        if (ritualOnlyVisuals) {
            // 放生阶段仅允许“放生手势”切换，不让其他手势影响鱼群
            const target = new THREE.Vector3(
                Math.sin(time * 0.3) * 60,
                Math.cos(time * 0.4) * 40,
                0
            );
            updateBoids(target, 'follow');
        } else if (handData.detected) {
            const hx = -handData.palmX * 180;
            const hy = -handData.palmY * 180;
            if (handData.fingersUp <= 1) {
                // 握拳：鱼群强烈追随拳头位置
                updateBoids(new THREE.Vector3(hx, hy, 0), 'attract');
            } else if (handData.fingersUp >= 4) {
                // 张手：鱼群从手掌散开
                updateBoids(new THREE.Vector3(hx, hy, 0), 'scatter');
            } else {
                // 中间状态：温和跟随
                updateBoids(new THREE.Vector3(hx, hy, 0), 'follow');
            }
        } else {
            // 无手势时自由游动
            const target = new THREE.Vector3(
                Math.sin(time * 0.3) * 60,
                Math.cos(time * 0.4) * 40,
                0
            );
            updateBoids(target, 'follow');
        }
    }

    controls.update();

    // 更新水下特效
    if (bubbleSystem) bubbleSystem.update(dt);
    if (splashSystem) splashSystem.update(dt);
    if (causticsEffect) {
        causticsEffect.update(time);
        // 焦散面始终面对相机（不跟随场景旋转）
        causticsEffect.mesh.quaternion.copy(camera.quaternion);
        // 焦散在钓鱼和放生阶段更明显
        const targetIntensity = currentPhase === PHASES.LANTERN_SWARM ? 0.0 : 0.58;
        causticsEffect.uniforms.uIntensity.value += (targetIntensity - causticsEffect.uniforms.uIntensity.value) * 0.02;
    }
    
    // 渲染顺序：先水波纹背景（屏幕空间），再3D场景叠加
    if (rippleScene && rippleCamera && !document.body.classList.contains('lantern-night-stage')) {
        renderer.autoClear = true;
        renderer.render(rippleScene, rippleCamera);
        renderer.autoClear = false;
        renderer.clearDepth(); // 清除深度缓冲，确保3D场景（含焦散）不被背景遮挡
        renderer.render(scene, camera);
        renderer.autoClear = true;
    } else {
        renderer.render(scene, camera);
    }
}

// ═══════════════════════════════════════════════════════
// 启动！
// ═══════════════════════════════════════════════════════
const BOOT_TIMEOUT_MS = 90000;
const bootTimer = setTimeout(() => {
    if (!loaderReady) {
        setLoaderProgress(0, '加载较慢，请稍候或刷新…');
        showToast('加载时间较长，正在等待模型与点云…', 4000);
    }
}, 20000);

init()
    .catch((err) => {
        console.error('[FATAL] init failed:', err);
        setLoaderProgress(0, '启动失败：' + (err?.message || err));
        showToast('启动失败：' + (err?.message || err), 6000);
        hideLoader();
        enterPhase(PHASES.WATER);
        animate();
    })
    .finally(() => clearTimeout(bootTimer));
